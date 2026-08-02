// Phase 6 gate tests: "Draft order + invoice — one order in Shopify, never two."
//
// The idempotency contract under test (master doc, Idempotency + Commitment):
//   - conversationOrderKey is written to Neon BEFORE any draftOrderCreate
//   - check-before-create by the mo-key tag
//   - timeout → lookup by tag, never blind retry
//   - duplicate confirm delivery → answered from state, zero creates

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, adminMock } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { findUnique: vi.fn(), update: vi.fn() },
  },
  adminMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
// Fully mocked: the real shopify.server initializes Prisma session storage,
// which cannot run inside vitest.
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

import {
  buildOrderSummaryText,
  confirmMessengerOrder,
  missingOrderFields,
  orderKeyTag,
  parseOrderState,
  updateMessengerOrderState,
} from "../app/services/messenger-orders.server";
import type {
  MessengerOrderState,
  OrderValidationDeps,
} from "../app/services/messenger-orders.server";

const PSID = "24681357900001";
const NOW = new Date("2026-08-02T04:00:00Z"); // Sunday Aug 2, noon Manila
const KEY = "3f1c9d2e-1111-2222-3333-444455556666";

const VARIANT_ID = "gid://shopify/ProductVariant/111";

const graphqlMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function threadRow(state: MessengerOrderState | null, overrides: Record<string, unknown> = {}) {
  return {
    psid: PSID,
    humanControl: false,
    disclosedBot: true,
    state: "idle",
    orderStateJson: state ? JSON.stringify(state) : null,
    conversationOrderKey: state?.orderKey ?? null,
    ...overrides,
  };
}

function completeState(overrides: Partial<MessengerOrderState> = {}): MessengerOrderState {
  return {
    status: "awaiting_confirm",
    variantId: VARIANT_ID,
    productTitle: "Sweet Heart",
    pricePhp: 799,
    deliveryDate: "2026-08-05",
    timeSlot: "9AM-12PM",
    recipientName: "Maria Clara Santos",
    address: "12 Sampaguita St, Brgy. Malanday",
    addressCity: "Marikina",
    phone: "09171234567",
    cardMessage: "Happy birthday!",
    orderKey: KEY,
    ...overrides,
  };
}

function openSlots(date: string) {
  return {
    ok: true as const,
    date,
    weekday: "Wednesday",
    available: true as const,
    slots: [
      { value: "9AM-12PM", label: "9AM-12PM" },
      { value: "12PM-3PM", label: "12PM-3PM" },
    ],
  };
}

function makeDeps(overrides: Partial<OrderValidationDeps> = {}): OrderValidationDeps {
  return {
    getVariant: vi.fn().mockResolvedValue({
      ok: true,
      product: {
        productTitle: "Sweet Heart",
        variantId: VARIANT_ID,
        pricePhp: 799,
        available: true,
      },
    }),
    getSlots: vi.fn().mockImplementation(async (input: { date?: string }) => openSlots(input.date ?? "")),
    checkCoverage: vi.fn().mockReturnValue({
      ok: true,
      covered: true,
      matches: [{ zip: "1805", city: "Marikina", area: "Malanday" }],
      feeNote: "estimate",
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
  prismaMock.messengerThread.findUnique.mockReset();
  prismaMock.messengerThread.update.mockReset();
  prismaMock.messengerThread.update.mockResolvedValue({});
  graphqlMock.mockReset();
  adminMock.mockReset();
  adminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// State machine — updateMessengerOrderState
// ---------------------------------------------------------------------------

describe("updateMessengerOrderState (slot-filling state machine — code advances state)", () => {
  it("fails designed when the thread is unknown", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(null);
    const result = await updateMessengerOrderState(PSID, {}, makeDeps(), NOW);
    expect(result.ok).toBe(false);
  });

  it("reports the required fields in the fixed conversation order", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const result = await updateMessengerOrderState(PSID, {}, makeDeps(), NOW);
    expect(result).toMatchObject({
      ok: true,
      readyToConfirm: false,
      missing: ["product", "delivery_date", "time_slot", "recipient_name", "address", "phone"],
    });
  });

  it("saves the product from a live-validated variant", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps();
    const result = await updateMessengerOrderState(PSID, { variant_id: VARIANT_ID }, deps, NOW);
    expect(deps.getVariant).toHaveBeenCalledWith(VARIANT_ID);
    expect(result).toMatchObject({
      ok: true,
      state: { productTitle: "Sweet Heart", pricePhp: 799 },
      missing: ["delivery_date", "time_slot", "recipient_name", "address", "phone"],
    });
  });

  it("rejects an out-of-stock variant without saving it", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps({
      getVariant: vi.fn().mockResolvedValue({
        ok: true,
        product: { productTitle: "X", variantId: VARIANT_ID, pricePhp: 1, available: false },
      }),
    });
    const result = await updateMessengerOrderState(PSID, { variant_id: VARIANT_ID }, deps, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0]).toMatchObject({ field: "product" });
      expect(result.missing).toContain("product");
    }
  });

  it("rejects a closed/full date with the nearest available dates, unsaved", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps({
      getSlots: vi.fn().mockResolvedValue({
        ok: true,
        date: "2026-08-03",
        weekday: "Monday",
        available: false,
        reason: "Blocked date.",
        nearestAvailableDates: [{ date: "2026-08-04", weekday: "Tuesday" }],
      }),
    });
    const result = await updateMessengerOrderState(PSID, { delivery_date: "2026-08-03" }, deps, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0]).toMatchObject({
        field: "delivery_date",
        nearestAvailableDates: [{ date: "2026-08-04", weekday: "Tuesday" }],
      });
      expect(result.state.deliveryDate).toBeUndefined();
    }
  });

  it("rejects a non-ISO delivery date (dates come from resolve_date only)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const result = await updateMessengerOrderState(
      PSID,
      { delivery_date: "bukas" },
      makeDeps(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].field).toBe("delivery_date");
    }
  });

  it("refuses a time slot before a date is set (slots are per-date)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const result = await updateMessengerOrderState(PSID, { time_slot: "9AM-12PM" }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0]).toMatchObject({ field: "time_slot" });
      expect(result.state.timeSlot).toBeUndefined();
    }
  });

  it("refuses a slot that is not open on the chosen date", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ status: "collecting", deliveryDate: "2026-08-05" }),
    );
    const result = await updateMessengerOrderState(PSID, { time_slot: "3PM-6PM" }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].error).toContain("not an open slot");
    }
  });

  it("accepts an open slot for the saved date", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ status: "collecting", deliveryDate: "2026-08-05" }),
    );
    const result = await updateMessengerOrderState(PSID, { time_slot: "9AM-12PM" }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.timeSlot).toBe("9AM-12PM");
    }
  });

  it("clears a saved slot when the date changes and the slot is no longer open", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ status: "collecting", deliveryDate: "2026-08-05", timeSlot: "9AM-12PM" }),
    );
    const deps = makeDeps({
      getSlots: vi.fn().mockResolvedValue({
        ok: true,
        date: "2026-08-06",
        weekday: "Thursday",
        available: true,
        slots: [{ value: "12PM-3PM", label: "12PM-3PM" }],
      }),
    });
    const result = await updateMessengerOrderState(PSID, { delivery_date: "2026-08-06" }, deps, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.deliveryDate).toBe("2026-08-06");
      expect(result.state.timeSlot).toBeUndefined();
      expect(result.missing).toContain("time_slot");
    }
  });

  it("requires address_area or address_zip so coverage can be checked", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps();
    const result = await updateMessengerOrderState(PSID, { address: "12 Sampaguita St" }, deps, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].field).toBe("address");
      expect(result.state.address).toBeUndefined();
    }
    expect(deps.checkCoverage).not.toHaveBeenCalled();
  });

  it("refuses an address outside delivery coverage", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps({
      checkCoverage: vi.fn().mockReturnValue({ ok: true, covered: false, note: "Not in the list." }),
    });
    const result = await updateMessengerOrderState(
      PSID,
      { address: "1 Rizal St", address_area: "Baguio" },
      deps,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].error).toContain("outside the delivery coverage");
      expect(result.state.address).toBeUndefined();
    }
  });

  it("saves a covered address with the matched city", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const deps = makeDeps();
    const result = await updateMessengerOrderState(
      PSID,
      { address: "12 Sampaguita St, Brgy. Malanday", address_area: "Malanday" },
      deps,
      NOW,
    );
    expect(deps.checkCoverage).toHaveBeenCalledWith({ area: "Malanday" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.address).toBe("12 Sampaguita St, Brgy. Malanday");
    }
  });

  it("rejects an implausible phone number", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(null));
    const result = await updateMessengerOrderState(PSID, { phone: "12" }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].field).toBe("phone");
    }
  });

  it("clears ONLY the requested field and returns to the furthest incomplete state", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(completeState()));
    const result = await updateMessengerOrderState(
      PSID,
      { clear: ["delivery_date"] },
      makeDeps(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Date cleared → dependent slot cleared too; everything else intact.
      expect(result.missing).toEqual(["delivery_date", "time_slot"]);
      expect(result.state.recipientName).toBe("Maria Clara Santos");
      expect(result.state.productTitle).toBe("Sweet Heart");
      expect(result.readyToConfirm).toBe(false);
    }
  });

  it("mints and persists the conversationOrderKey to Neon when the order becomes complete", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow(completeState({ status: "collecting", phone: undefined, orderKey: undefined })),
    );
    const result = await updateMessengerOrderState(PSID, { phone: "09171234567" }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readyToConfirm).toBe(true);
    expect(result.orderKey).toMatch(/^[0-9a-f-]{36}$/);

    // The key is in Neon BEFORE any Shopify call could ever happen.
    const updateArgs = prismaMock.messengerThread.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ psid: PSID });
    expect(updateArgs.data.conversationOrderKey).toBe(result.orderKey);
    const savedState = JSON.parse(updateArgs.data.orderStateJson as string);
    expect(savedState.status).toBe("awaiting_confirm");
    expect(savedState.orderKey).toBe(result.orderKey);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("keeps the same orderKey across later edits (the key identifies the attempt, not the content)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(completeState()));
    const result = await updateMessengerOrderState(
      PSID,
      { recipient_name: "Juan Dela Cruz" },
      makeDeps(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orderKey).toBe(KEY);
    }
  });

  it("blocks edits after the order is created (chat cannot mutate a live draft)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow(completeState({ status: "created", invoiceUrl: "https://x/invoice" })),
    );
    const result = await updateMessengerOrderState(
      PSID,
      { recipient_name: "Else" },
      makeDeps(),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.errors[0].field).toBe("status");
      expect(result.readyToConfirm).toBe(false);
    }
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled();
  });

  it("clear: [\"all\"] starts a fresh order and drops the key from Neon", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow(completeState({ status: "created" })),
    );
    const result = await updateMessengerOrderState(PSID, { clear: ["all"] }, makeDeps(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missing).toHaveLength(6);
    }
    const updateArgs = prismaMock.messengerThread.update.mock.calls[0][0];
    expect(updateArgs.data.conversationOrderKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotent create — confirmMessengerOrder (THE phase-6 gate)
// ---------------------------------------------------------------------------

function isCreateCall(call: unknown[]): boolean {
  return typeof call[0] === "string" && call[0].includes("draftOrderCreate");
}

function isLookupCall(call: unknown[]): boolean {
  return typeof call[0] === "string" && call[0].includes("draftOrders(");
}

const DRAFT_NODE = {
  id: "gid://shopify/DraftOrder/9001",
  name: "#D123",
  invoiceUrl: "https://shop.example/invoice/abc",
};

function emptyLookupResponse() {
  return jsonResponse({ data: { draftOrders: { nodes: [] } } });
}

function foundLookupResponse() {
  return jsonResponse({ data: { draftOrders: { nodes: [DRAFT_NODE] } } });
}

function createOkResponse() {
  return jsonResponse({
    data: { draftOrderCreate: { draftOrder: DRAFT_NODE, userErrors: [] } },
  });
}

describe("confirmMessengerOrder (idempotent draft-order create)", () => {
  beforeEach(() => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow(completeState()));
  });

  it("degrades to transient when MESSENGER_SHOP is missing (no create attempt)", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: false, code: "transient" });
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("rejects a stale confirm tap without any Shopify call", async () => {
    const result = await confirmMessengerOrder(PSID, "some-old-key", NOW);
    expect(result).toMatchObject({ ok: false, code: "stale_key" });
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("rejects an incomplete order without any Shopify call", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow(completeState({ phone: undefined, status: "collecting" })),
    );
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: false, code: "incomplete" });
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("creates the draft with the EXACT frozen attribute/tag shapes and the 15-minute stock hold", async () => {
    graphqlMock.mockImplementation(async (query: string) =>
      query.includes("draftOrderCreate") ? createOkResponse() : emptyLookupResponse(),
    );

    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({
      ok: true,
      invoiceUrl: DRAFT_NODE.invoiceUrl,
      draftOrderName: "#D123",
      alreadyCreated: false,
    });

    const createCall = graphqlMock.mock.calls.find(isCreateCall);
    expect(createCall).toBeDefined();
    const input = (createCall?.[1] as { variables: { input: Record<string, unknown> } }).variables
      .input;

    // Frozen checkout shape — the existing orders/create sync keys on these.
    expect(input.customAttributes).toEqual([
      { key: "Delivery Date", value: "2026-08-05" },
      { key: "Delivery Time", value: "9AM-12PM" },
      { key: "conversationOrderKey", value: KEY },
      { key: "messengerPsid", value: PSID },
    ]);
    expect(input.tags).toEqual(["messenger", orderKeyTag(KEY), "2026-08-05", "9AM-12PM"]);
    expect(input.lineItems).toEqual([{ variantId: VARIANT_ID, quantity: 1 }]);
    expect(input.sourceName).toBe("messenger");
    // reserveInventoryUntil ≈ now + 15 minutes.
    expect(input.reserveInventoryUntil).toBe(
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    );
    expect(input.shippingAddress).toMatchObject({
      firstName: "Maria",
      lastName: "Clara Santos",
      address1: "12 Sampaguita St, Brgy. Malanday",
      city: "Marikina",
      phone: "09171234567",
      countryCode: "PH",
    });
    expect(input.note).toContain("Happy birthday!");

    // State persisted as created with the invoice link.
    const updateArgs = prismaMock.messengerThread.update.mock.calls.at(-1)?.[0];
    const savedState = JSON.parse(updateArgs?.data.orderStateJson as string);
    expect(savedState).toMatchObject({
      status: "created",
      draftOrderId: DRAFT_NODE.id,
      invoiceUrl: DRAFT_NODE.invoiceUrl,
    });
  });

  it("GATE: a duplicate confirm after success answers from state — zero Shopify calls", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow(
        completeState({
          status: "created",
          draftOrderId: DRAFT_NODE.id,
          draftOrderName: "#D123",
          invoiceUrl: DRAFT_NODE.invoiceUrl,
        }),
      ),
    );
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: true, alreadyCreated: true, invoiceUrl: DRAFT_NODE.invoiceUrl });
    expect(adminMock).not.toHaveBeenCalled();
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("GATE: check-before-create adopts an existing draft found by tag — no second create", async () => {
    graphqlMock.mockImplementation(async (query: string) =>
      query.includes("draftOrderCreate") ? createOkResponse() : foundLookupResponse(),
    );
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: true, invoiceUrl: DRAFT_NODE.invoiceUrl });
    expect(graphqlMock.mock.calls.filter(isCreateCall)).toHaveLength(0);
    // The lookup query keys on the idempotency tag.
    const lookupCall = graphqlMock.mock.calls.find(isLookupCall);
    expect(
      (lookupCall?.[1] as { variables: { query: string } }).variables.query,
    ).toBe(`tag:'${orderKeyTag(KEY)}'`);
  });

  it("GATE: timeout then Cloud Tasks retry → exactly ONE draftOrderCreate across both attempts", async () => {
    // Attempt 1: pre-create lookup empty; the create call times out — but the
    // draft actually landed on Shopify's side; the post-timeout lookup races
    // and still sees nothing.
    graphqlMock.mockImplementation(async (query: string) => {
      if (query.includes("draftOrderCreate")) {
        throw new Error("ETIMEDOUT");
      }
      return emptyLookupResponse();
    });
    const first = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(first).toMatchObject({ ok: false, code: "transient" });
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled(); // still awaiting_confirm

    // Attempt 2 (the retry): the check-before-create now finds the draft by
    // its tag and adopts it — it must NOT create again.
    graphqlMock.mockImplementation(async (query: string) => {
      if (query.includes("draftOrderCreate")) {
        return createOkResponse();
      }
      return foundLookupResponse();
    });
    const second = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(second).toMatchObject({ ok: true, invoiceUrl: DRAFT_NODE.invoiceUrl });

    expect(graphqlMock.mock.calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("adopts the draft on a post-timeout lookup hit (create landed despite the thrown error)", async () => {
    let lookups = 0;
    graphqlMock.mockImplementation(async (query: string) => {
      if (query.includes("draftOrderCreate")) {
        throw new Error("socket hang up");
      }
      lookups += 1;
      return lookups === 1 ? emptyLookupResponse() : foundLookupResponse();
    });
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: true, invoiceUrl: DRAFT_NODE.invoiceUrl });
    expect(graphqlMock.mock.calls.filter(isCreateCall)).toHaveLength(1);
  });

  it("returns transient (not create) when the pre-create lookup itself fails — absence unproven", async () => {
    graphqlMock.mockImplementation(async (query: string) => {
      if (query.includes("draftOrderCreate")) {
        return createOkResponse();
      }
      return jsonResponse({ errors: [{ message: "THROTTLED" }] });
    });
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: false, code: "transient" });
    expect(graphqlMock.mock.calls.filter(isCreateCall)).toHaveLength(0);
  });

  it("treats draftOrderCreate userErrors as permanent failure (retry cannot help)", async () => {
    graphqlMock.mockImplementation(async (query: string) =>
      query.includes("draftOrderCreate")
        ? jsonResponse({
            data: {
              draftOrderCreate: {
                draftOrder: null,
                userErrors: [{ field: ["input"], message: "Variant no longer exists" }],
              },
            },
          })
        : emptyLookupResponse(),
    );
    const result = await confirmMessengerOrder(PSID, KEY, NOW);
    expect(result).toMatchObject({ ok: false, code: "failed" });
  });
});

// ---------------------------------------------------------------------------
// Summary + small helpers
// ---------------------------------------------------------------------------

describe("buildOrderSummaryText", () => {
  it("echoes every collected detail, with the weekday on the date (bad-parse catch)", () => {
    const text = buildOrderSummaryText(completeState());
    expect(text).toContain("Sweet Heart");
    expect(text).toContain("₱799");
    expect(text).toContain("Wednesday, 2026-08-05");
    expect(text).toContain("9AM-12PM");
    expect(text).toContain("Maria Clara Santos");
    expect(text).toContain("12 Sampaguita St");
    expect(text).toContain("09171234567");
    expect(text).toContain("Happy birthday!");
    expect(text).toContain("Confirm");
  });
});

describe("parseOrderState / missingOrderFields", () => {
  it("falls back to a fresh collecting state on unparseable JSON", () => {
    expect(parseOrderState("{nope")).toEqual({ status: "collecting" });
    expect(parseOrderState(null)).toEqual({ status: "collecting" });
  });

  it("computes missing fields in the canonical order", () => {
    expect(missingOrderFields({ status: "collecting", deliveryDate: "2026-08-05" })).toEqual([
      "product",
      "time_slot",
      "recipient_name",
      "address",
      "phone",
    ]);
  });
});

describe("orderKeyTag (Shopify 40-char tag limit)", () => {
  it("stays within 40 chars for a full UUID key (live 2026-08-02 failure)", () => {
    const tag = orderKeyTag("453b023a-9baf-4640-bac2-b9f770914627");
    expect(tag.length).toBeLessThanOrEqual(40);
    expect(tag).toBe("mo-key-453b023a9baf4640bac2b9f770914627");
  });
});
