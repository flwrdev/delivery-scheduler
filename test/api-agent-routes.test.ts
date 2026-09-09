import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphqlMock, adminMock, findCodFeeVariantMock, reservations } = vi.hoisted(() => ({
  graphqlMock: vi.fn(),
  adminMock: vi.fn(),
  findCodFeeVariantMock: vi.fn(),
  reservations: new Map<string, Record<string, unknown>>(),
}));
adminMock.mockImplementation(async () => ({ admin: { graphql: graphqlMock } }));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

// In-memory stand-in for the AgentOrderRequest table with Prisma's unique-violation shape.
vi.mock("../app/db.server", () => ({
  default: {
    agentOrderRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.idempotencyKey);
        if (reservations.has(key)) {
          const err = new Error("Unique constraint failed") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row = { draftId: null, orderId: null, lockedAt: new Date(), ...data };
        reservations.set(key, row);
        return row;
      },
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => reservations.get(where.idempotencyKey) ?? null,
      update: async ({ where, data }: { where: { idempotencyKey: string }; data: Record<string, unknown> }) => {
        const row = reservations.get(where.idempotencyKey);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: { idempotencyKey: string; status: { in: string[] }; lockedAt: { lt: Date } }; data: Record<string, unknown> }) => {
        const row = reservations.get(where.idempotencyKey);
        if (!row || !where.status.in.includes(String(row.status)) || !((row.lockedAt as Date) < where.lockedAt.lt)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      delete: async ({ where }: { where: { idempotencyKey: string } }) => {
        reservations.delete(where.idempotencyKey);
        return {};
      },
    },
  },
}));

vi.mock("../app/services/schedule-rules.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/schedule-rules.server")>();
  const { DEFAULT_DELIVERY_SCHEDULE_RULES } = await import("../app/lib/delivery-availability");
  return { ...actual, getScheduleRulesWithBookedCounts: vi.fn(async () => DEFAULT_DELIVERY_SCHEDULE_RULES) };
});

vi.mock("../app/services/cod-fee.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/cod-fee.server")>();
  return { ...actual, findCodFeeVariant: findCodFeeVariantMock };
});

import { addDays, getShopLocalDate } from "../app/lib/delivery-availability";
import { resetAgentRateLimits } from "../app/lib/verify-agent-token.server";
import { action as draftAction } from "../app/routes/api.agent.orders.draft";
import { loader as statusLoader } from "../app/routes/api.agent.orders.status";
import { loader as quoteLoader } from "../app/routes/api.agent.delivery.quote";
import { RESERVATION_STALE_MS, agentKeyTag } from "../app/services/agent-api.server";

const TOKEN = "agent-test-token";
const BASE = "https://app.example.com";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(path: string, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, { headers });
}

const futureDate = addDays(getShopLocalDate(), 3);

function validDraftBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "conv-abc-1",
    customer: { email: "Buyer@Example.com", firstName: "Ana" },
    recipient: { name: "Maria Santos", phone: "09171234567", address1: "12 Sample St", city: "Makati", zip: "1200" },
    items: [{ productHandle: "autumn-morning", quantity: 1 }],
    delivery: { date: futureDate, timeSlot: "9AM-12PM", cardMessage: "Happy birthday" },
    deliveryFee: 160,
    paymentMode: "invoice",
    channel: { psid: "100000493184591" },
    ...overrides,
  };
}

type Call = { query: string; variables: Record<string, unknown> };
function calls(): Call[] {
  return graphqlMock.mock.calls.map(([query, opts]) => ({
    query: String(query),
    variables: (opts as { variables?: Record<string, unknown> } | undefined)?.variables ?? {},
  }));
}

const DEFAULT_PRODUCT = {
  id: "gid://shopify/Product/1",
  title: "Autumn Morning",
  handle: "autumn-morning",
  status: "ACTIVE",
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "Default Title", price: "799.00", availableForSale: true }] },
};
const DEFAULT_CREATED = {
  id: "gid://shopify/DraftOrder/500",
  name: "#D500",
  status: "OPEN",
  invoiceUrl: "https://shop.example.com/invoices/abc",
  totalPriceSet: { shopMoney: { amount: "959.00" } },
};

function routeGraphql(options: {
  product?: unknown;
  created?: unknown;
  completed?: unknown | null;
  order?: unknown;
  draftById?: unknown;
  codConfig?: unknown;
  codConfigError?: boolean;
} = {}) {
  graphqlMock.mockImplementation(async (query: string) => {
    if (query.includes("AgentDraftById")) {
      return jsonResponse({ data: { draftOrder: options.draftById ?? null } });
    }
    if (query.includes("AgentProductSearch")) {
      return jsonResponse({ data: { products: { nodes: [options.product ?? DEFAULT_PRODUCT] } } });
    }
    if (query.includes("AgentVariantById")) {
      return jsonResponse({
        data: {
          productVariant: {
            id: "gid://shopify/ProductVariant/12",
            title: "Default Title",
            price: "899.00",
            availableForSale: false,
            product: { title: "Sold Out Bouquet", status: "ACTIVE" },
          },
        },
      });
    }
    if (query.includes("AgentCodConfig")) {
      if (options.codConfigError) return jsonResponse({ errors: [{ message: "boom" }] });
      return jsonResponse({
        data: {
          paymentCustomizations: {
            nodes: [
              {
                title: "Cash on Delivery",
                metafield: { jsonValue: options.codConfig ?? { feeAmount: 70, minimumAmount: 0, maximumAmount: 2500 } },
              },
            ],
          },
        },
      });
    }
    if (query.includes("AgentDraftCreate")) {
      return jsonResponse({ data: { draftOrderCreate: { draftOrder: options.created ?? DEFAULT_CREATED, userErrors: [] } } });
    }
    if (query.includes("AgentDraftComplete")) {
      if (options.completed === null) {
        return jsonResponse({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ message: "Cannot complete" }] } } });
      }
      return jsonResponse({
        data: {
          draftOrderComplete: {
            draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D500", order: options.completed ?? { id: "gid://shopify/Order/900", name: "#4400" } },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes("TrackOrder")) {
      return jsonResponse({ data: { orders: { nodes: options.order ? [options.order] : [] } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });
}

async function callDraft(body: unknown) {
  return draftAction({ request: post("/api/agent/orders/draft", body), params: {}, context: {} } as never);
}

beforeEach(() => {
  vi.stubEnv("META_AGENT_API_TOKEN", TOKEN);
  vi.stubEnv("SHOP_DOMAIN", "flowercart-dev.myshopify.com");
  findCodFeeVariantMock.mockResolvedValue({
    variant: { id: "gid://shopify/ProductVariant/77", sku: "COD-FEE", price: "70.00", productId: "gid://shopify/Product/7" },
    errors: [],
  });
});

afterEach(() => {
  graphqlMock.mockReset();
  adminMock.mockClear();
  findCodFeeVariantMock.mockReset();
  reservations.clear();
  resetAgentRateLimits();
  vi.unstubAllEnvs();
});

describe("agentKeyTag", () => {
  it("keeps short keys verbatim and hashes long ones so the tag stays within 40 characters", () => {
    expect(agentKeyTag("conv-abc-1")).toBe("agent-key-conv-abc-1");
    const uuidTag = agentKeyTag("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(uuidTag.startsWith("agent-key-")).toBe(true);
    expect(uuidTag.length).toBeLessThanOrEqual(40);
    expect(agentKeyTag("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(uuidTag);
  });
});

describe("POST /api/agent/orders/draft", () => {
  it("rejects a missing token with 401 and never touches Shopify", async () => {
    const response = await draftAction({ request: post("/api/agent/orders/draft", validDraftBody(), null), params: {}, context: {} } as never);
    expect(response.status).toBe(401);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("returns 422 with the field list when required input is missing", async () => {
    const response = await callDraft({ idempotencyKey: "x", items: [] });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(body.error.code).toBe("validation");
    expect(body.error.fields).toEqual(expect.arrayContaining(["idempotencyKey", "customer.email", "recipient.name", "items", "delivery.date"]));
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("rejects more than the item limit instead of truncating", async () => {
    const items = Array.from({ length: 11 }, () => ({ productHandle: "autumn-morning", quantity: 1 }));
    const response = await callDraft(validDraftBody({ items }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { fields: string[] } };
    expect(body.error.fields.some((f) => f.startsWith("items (max"))).toBe(true);
  });

  it("creates a draft with delivery attributes, tags, PSID, and returns the invoice URL", async () => {
    routeGraphql();
    const response = await callDraft(validDraftBody());
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      reused: false,
      mode: "draft",
      draftName: "#D500",
      invoiceUrl: "https://shop.example.com/invoices/abc",
      total: 959,
      delivery: { date: futureDate, timeSlot: "9AM-12PM" },
    });
    expect((body.summary as { items: unknown[] }).items).toEqual([{ title: "Autumn Morning", quantity: 1, price: 799 }]);

    const create = calls().find((c) => c.query.includes("AgentDraftCreate"));
    const input = create?.variables.input as Record<string, unknown>;
    expect(input.email).toBe("buyer@example.com");
    expect(input.lineItems).toEqual([{ variantId: "gid://shopify/ProductVariant/11", quantity: 1 }]);
    expect(input.tags).toEqual([futureDate, "9AM-12PM", "source:messenger", "agent-key-conv-abc-1"]);
    expect(input.customAttributes).toEqual(
      expect.arrayContaining([
        { key: "Delivery Date", value: futureDate },
        { key: "Delivery Time", value: "9AM-12PM" },
        { key: "Card Message", value: "Happy birthday" },
        { key: "_Messenger PSID", value: "100000493184591" },
      ]),
    );
    expect(input.shippingLine).toEqual({ title: "LALAMOVE", priceWithCurrency: { amount: 160, currencyCode: "PHP" } });
    expect(calls().some((c) => c.query.includes("AgentDraftComplete"))).toBe(false);
    expect(reservations.get("conv-abc-1")).toMatchObject({ status: "drafted", draftId: "gid://shopify/DraftOrder/500" });
  });

  it("returns the existing draft for a repeated key without creating another", async () => {
    routeGraphql({
      draftById: { id: "gid://shopify/DraftOrder/1", name: "#D1", status: "OPEN", invoiceUrl: "https://shop.example.com/invoices/old", totalPriceSet: { shopMoney: { amount: "959.00" } }, order: null },
    });
    reservations.set("conv-abc-1", { idempotencyKey: "conv-abc-1", shop: "s", paymentMode: "invoice", status: "drafted", draftId: "gid://shopify/DraftOrder/1", orderId: null, lockedAt: new Date() });
    const response = await callDraft(validDraftBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reused: true, mode: "draft", draftName: "#D1", invoiceUrl: "https://shop.example.com/invoices/old" });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("answers 409 in_progress while the first request for the key is still running", async () => {
    routeGraphql();
    reservations.set("conv-abc-1", { idempotencyKey: "conv-abc-1", shop: "s", paymentMode: "invoice", status: "pending", draftId: null, orderId: null, lockedAt: new Date() });
    const response = await callDraft(validDraftBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "in_progress", retryAfterSeconds: 5 } });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("takes over an abandoned pending reservation and creates the draft", async () => {
    routeGraphql();
    reservations.set("conv-abc-1", {
      idempotencyKey: "conv-abc-1", shop: "s", paymentMode: "invoice", status: "pending", draftId: null, orderId: null,
      lockedAt: new Date(Date.now() - RESERVATION_STALE_MS - 1000),
    });
    const response = await callDraft(validDraftBody());
    expect(response.status).toBe(201);
    expect(reservations.get("conv-abc-1")).toMatchObject({ status: "drafted" });
  });

  it("retries COD completion when the earlier attempt left an open draft", async () => {
    routeGraphql({
      draftById: { id: "gid://shopify/DraftOrder/500", name: "#D500", status: "OPEN", invoiceUrl: null, totalPriceSet: { shopMoney: { amount: "1029.00" } }, order: null },
    });
    reservations.set("conv-cod-1", { idempotencyKey: "conv-cod-1", shop: "s", paymentMode: "cod", status: "drafted", draftId: "gid://shopify/DraftOrder/500", orderId: null, lockedAt: new Date() });
    const response = await callDraft(validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reused: true, mode: "order", orderName: "#4400" });
    expect(calls().some((c) => c.query.includes("AgentDraftComplete"))).toBe(true);
    expect(reservations.get("conv-cod-1")).toMatchObject({ status: "completed", orderId: "gid://shopify/Order/900" });
  });

  it("releases the reservation when validation fails before any Shopify write", async () => {
    routeGraphql();
    const response = await callDraft(validDraftBody({ delivery: { date: "2020-01-01", timeSlot: "9AM-12PM" } }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; availableSlots: string[]; minDate: string } };
    expect(body.error.code).toBe("date_before_min");
    expect(body.error.minDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reservations.has("conv-abc-1")).toBe(false);
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("rejects a destination outside the coverage list", async () => {
    routeGraphql();
    const response = await callDraft(validDraftBody({ recipient: { name: "Juan", address1: "Road 1", city: "Cebu City" } }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "not_covered" } });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("rejects a variant that is not available for sale", async () => {
    routeGraphql();
    const response = await callDraft(validDraftBody({ items: [{ variantId: "gid://shopify/ProductVariant/12", quantity: 1 }] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "product_not_found" } });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("completes a COD order with the COD-FEE line and paymentPending", async () => {
    routeGraphql();
    const response = await callDraft(validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-2" }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, mode: "order", orderName: "#4400", statusPageUrl: "https://flowercart.store/pages/track?order=4400" });
    expect((body.summary as { codFee: number }).codFee).toBe(70);

    const create = calls().find((c) => c.query.includes("AgentDraftCreate"));
    const input = create?.variables.input as { lineItems: unknown[]; tags: string[] };
    expect(input.lineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
      { variantId: "gid://shopify/ProductVariant/77", quantity: 1 },
    ]);
    expect(input.tags).toContain("cod");
    const complete = calls().find((c) => c.query.includes("AgentDraftComplete"));
    expect(complete?.variables).toMatchObject({ id: "gid://shopify/DraftOrder/500", paymentPending: true });
    expect(reservations.get("conv-cod-2")).toMatchObject({ status: "completed" });
  });

  it("keeps the drafted reservation when COD completion fails so a retry can finish it", async () => {
    routeGraphql({ completed: null });
    const response = await callDraft(validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-3" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "draft_complete_failed", retryable: true } });
    expect(reservations.get("conv-cod-3")).toMatchObject({ status: "drafted", draftId: "gid://shopify/DraftOrder/500" });
  });

  it("refuses COD outside Metro Manila and for a same-named city in another province", async () => {
    routeGraphql();
    const imus = await callDraft(validDraftBody({ paymentMode: "cod", recipient: { name: "Juan", address1: "Road 1", city: "Imus", zip: "4103" } }));
    expect(imus.status).toBe(422);
    expect(await imus.json()).toMatchObject({ error: { code: "cod_not_available" } });

    const quezonProvince = await callDraft(
      validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-4", recipient: { name: "Juan", address1: "Road 1", city: "Quezon", province: "Quezon" } }),
    );
    expect(quezonProvince.status).toBe(422);
    expect(await quezonProvince.json()).toMatchObject({ error: { code: "cod_not_available" } });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("fails closed on COD when the payment-customization config cannot be read", async () => {
    routeGraphql({ codConfigError: true });
    const response = await callDraft(validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-5" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "cod_unavailable" } });
    expect(reservations.has("conv-cod-5")).toBe(false);
  });

  it("applies the checkout Function's 2500 minimum when the config omits minimumAmount", async () => {
    routeGraphql({ codConfig: { feeAmount: 70, maximumAmount: 5000 } });
    const response = await callDraft(validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-6" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "cod_not_available", message: expect.stringContaining("2500") } });
  });
});

describe("GET /api/agent/orders/status", () => {
  it("returns 404 when the order number and email do not match", async () => {
    routeGraphql({ order: null });
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=4220&email=x@y.com"), params: {}, context: {} } as never);
    expect(response.status).toBe(404);
  });

  it("returns the stage, links, and a Taglish message for a matching order", async () => {
    routeGraphql({
      order: {
        name: "#4220",
        email: "x@y.com",
        phone: null,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "UNFULFILLED",
        customAttributes: [
          { key: "Delivery Date", value: futureDate },
          { key: "Delivery Time", value: "3PM-6PM" },
        ],
        shippingAddress: { phone: null },
        fulfillments: [],
        lineItems: { nodes: [{ title: "Autumn Morning", quantity: 1 }] },
      },
    });
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=%234220&email=X@y.com"), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      orderName: "#4220",
      stage: "confirmed",
      delivery: { date: futureDate, timeSlot: "3PM-6PM" },
      statusPageUrl: "https://flowercart.store/pages/track?order=4220",
      canReschedule: true,
      reschedulePageUrl: "https://flowercart.store/account",
      message: expect.stringContaining("#4220"),
    });
  });

  it("requires an email", async () => {
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=4220"), params: {}, context: {} } as never);
    expect(response.status).toBe(422);
  });
});

describe("GET /api/agent/delivery/quote", () => {
  it("quotes a covered Metro Manila city with COD availability and slots", async () => {
    routeGraphql();
    const response = await quoteLoader({ request: get(`/api/agent/delivery/quote?city=Makati&date=${futureDate}`), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, covered: true, freeShippingAbovePhp: 2500, cod: { configLoaded: true, availableInArea: true, feeAmount: 70, maximumAmount: 2500 } });
    expect(typeof body.feeMin).toBe("number");
    expect(body.slots).toEqual(["9AM-12PM", "12PM-3PM", "3PM-6PM", "6PM-11PM"]);
    expect((body.date as { valid: boolean; availableSlots: string[] }).valid).toBe(true);
  });

  it("marks a provincial town as covered but not COD-eligible", async () => {
    routeGraphql();
    const response = await quoteLoader({ request: get("/api/agent/delivery/quote?city=Imus"), params: {}, context: {} } as never);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, covered: true, cod: { availableInArea: false } });
    expect(body.provincialNote).toBeTruthy();
  });

  it("reports COD as unavailable when the config cannot be read", async () => {
    routeGraphql({ codConfigError: true });
    const response = await quoteLoader({ request: get("/api/agent/delivery/quote?city=Makati"), params: {}, context: {} } as never);
    expect(await response.json()).toMatchObject({ ok: true, cod: { configLoaded: false, availableInArea: false } });
  });

  it("returns 422 without a city or zip", async () => {
    const response = await quoteLoader({ request: get("/api/agent/delivery/quote"), params: {}, context: {} } as never);
    expect(response.status).toBe(422);
  });
});
