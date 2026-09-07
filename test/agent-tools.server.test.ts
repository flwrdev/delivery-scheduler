import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rulesMock, adminMock, updateOrderMock, prismaMock } = vi.hoisted(() => ({
  rulesMock: vi.fn(),
  adminMock: vi.fn(),
  updateOrderMock: vi.fn(),
  prismaMock: {
    messengerThread: { findUnique: vi.fn(), update: vi.fn() },
    lookupAttempt: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesWithBookedCounts: rulesMock,
}));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));
// Fully mocked: messenger-orders and order-lookup both import db.server
// (Prisma) and shopify.server.
vi.mock("../app/services/messenger-orders.server", () => ({
  updateMessengerOrderState: updateOrderMock,
}));
vi.mock("../app/db.server", () => ({ default: prismaMock }));

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";
import {
  executeAgentTool,
  LOOKUP_MY_ORDERS_TOOL,
  MESSENGER_AGENT_TOOLS,
  getAvailableDeliverySlots,
  resolveDeliveryDate,
} from "../app/services/agent-tools.server";

// 2026-08-01T04:00:00Z = Saturday Aug 1, 2026, 12:00 noon in Asia/Manila.
const NOW_MANILA_NOON_SAT = new Date("2026-08-01T04:00:00Z");

describe("MESSENGER_AGENT_TOOLS registry", () => {
  it("exposes exactly the phase-4 + phase-5 + phase-6 tool set (+ get_best_sellers)", () => {
    expect(MESSENGER_AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "check_delivery_coverage",
      "get_available_slots",
      "get_best_sellers",
      "get_product_details",
      "lookup_order",
      "resolve_date",
      "search_products",
      "update_order",
    ]);
    for (const tool of MESSENGER_AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("executeAgentTool — update_order dispatch (phase 6)", () => {
  beforeEach(() => {
    updateOrderMock.mockReset();
  });

  it("routes to the state machine with the thread psid and injected validators", async () => {
    updateOrderMock.mockResolvedValue({ ok: true, missing: [], readyToConfirm: false });
    const input = { recipient_name: "Maria" };
    const result = await executeAgentTool("update_order", input, NOW_MANILA_NOON_SAT, {
      psid: "PSID-1",
    });
    expect(result).toEqual({ ok: true, missing: [], readyToConfirm: false });
    expect(updateOrderMock).toHaveBeenCalledTimes(1);
    const [psid, passedInput, deps, now] = updateOrderMock.mock.calls[0];
    expect(psid).toBe("PSID-1");
    expect(passedInput).toEqual(input);
    expect(typeof deps.getVariant).toBe("function");
    expect(typeof deps.getSlots).toBe("function");
    expect(typeof deps.checkCoverage).toBe("function");
    expect(now).toBe(NOW_MANILA_NOON_SAT);
  });

  it("fails designed when the turn has no psid context", async () => {
    const result = (await executeAgentTool("update_order", {}, NOW_MANILA_NOON_SAT)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    expect(updateOrderMock).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — lookup_order dispatch (channel-agnostic lockout wiring)", () => {
  const graphqlMock = vi.fn();
  const THREAD_ID = "gid://shopify/Customer/778899";

  beforeEach(() => {
    vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
    adminMock.mockReset();
    adminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
    graphqlMock.mockReset();
    prismaMock.lookupAttempt.findUnique.mockReset();
    prismaMock.lookupAttempt.upsert.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails designed when neither threadId nor psid is present — the guard is never silently skipped", async () => {
    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "3979", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      {},
    )) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
    expect(prismaMock.lookupAttempt.findUnique).not.toHaveBeenCalled();
  });

  it("MAJOR fix: the lockout applies on threadId (customer-account/storefront), not only psid", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: new Date() });
    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "3979", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Too many failed lookup attempts");
    expect(prismaMock.lookupAttempt.findUnique).toHaveBeenCalledWith({
      where: { key: THREAD_ID },
      select: { lockedAt: true },
    });
    // Locked out means the tool must not even reach Shopify.
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("records a failure keyed by threadId (not MessengerThread/psid) when the web channel guesses wrong", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null }); // isLookupLocked
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ failures: 0, lockedAt: null }); // recordLookupFailure read
    prismaMock.lookupAttempt.upsert.mockResolvedValueOnce({});
    graphqlMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "0000", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled();
    expect(prismaMock.lookupAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: THREAD_ID } }),
    );
  });

  // MAJOR fix: an outage is not a wrong guess. Before this, a Shopify blip or
  // an unset MESSENGER_SHOP burned an attempt and could lock a blameless
  // customer out of order support for 30 minutes.
  it("does NOT record a failure when the lookup fails UPSTREAM (thrown GraphQL)", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null }); // isLookupLocked
    graphqlMock.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "3979", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("upstream");
    expect(prismaMock.lookupAttempt.upsert).not.toHaveBeenCalled();
  });

  it("does NOT record a failure when MESSENGER_SHOP is unset (upstream config, not a guess)", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null });

    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "3979", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("upstream");
    expect(prismaMock.lookupAttempt.upsert).not.toHaveBeenCalled();
  });

  it("does NOT record a failure for an AMBIGUOUS miss (full page, inconclusive search)", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null });
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      name: `#${1000 + i}`,
      shippingAddress: { zip: "1300" },
    }));
    graphqlMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { orders: { nodes } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "100", zip: "1300" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ambiguous");
    expect(prismaMock.lookupAttempt.upsert).not.toHaveBeenCalled();
  });

  it("DOES record a failure for a real MISMATCH (wrong zip on an existing order)", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null }); // isLookupLocked
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ failures: 0, lockedAt: null });
    prismaMock.lookupAttempt.upsert.mockResolvedValueOnce({});
    graphqlMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { orders: { nodes: [{ name: "#3979", shippingAddress: { zip: "1300" } }] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = (await executeAgentTool(
      "lookup_order",
      { order_number: "3979", zip: "9999" },
      NOW_MANILA_NOON_SAT,
      { threadId: THREAD_ID },
    )) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mismatch");
    expect(prismaMock.lookupAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: THREAD_ID } }),
    );
  });
});

// MINOR fix: on an authenticated surface Shopify already proved who the
// customer is, so they must never be made to recite an order number + zip (nor
// be lockout-able for getting it wrong).
describe("executeAgentTool — lookup_my_orders (authenticated surfaces)", () => {
  const graphqlMock = vi.fn();
  const CUSTOMER_GID = "gid://shopify/Customer/778899";

  beforeEach(() => {
    vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
    adminMock.mockReset();
    adminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
    graphqlMock.mockReset();
    prismaMock.lookupAttempt.findUnique.mockReset();
    prismaMock.lookupAttempt.upsert.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a no-input tool definition (the customer id NEVER comes from the LLM)", () => {
    expect(LOOKUP_MY_ORDERS_TOOL.name).toBe("lookup_my_orders");
    expect(LOOKUP_MY_ORDERS_TOOL.input_schema.properties).toEqual({});
    expect(LOOKUP_MY_ORDERS_TOOL.input_schema.required).toEqual([]);
    // It is NOT part of the Messenger registry — Messenger has no verified GID.
    expect(MESSENGER_AGENT_TOOLS.map((t) => t.name)).not.toContain("lookup_my_orders");
  });

  it("fails designed when the turn carries no verified customerGid", async () => {
    const result = (await executeAgentTool("lookup_my_orders", {}, NOW_MANILA_NOON_SAT, {
      threadId: "conv-1",
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("looks the orders up by the CONTEXT's customer id and never burns a lockout attempt", async () => {
    graphqlMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            orders: {
              nodes: [
                {
                  name: "#3979",
                  createdAt: "2026-08-02T16:00:00Z",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  shippingAddress: { zip: "1300", address1: "255 Kawit St", phone: "09624224085" },
                  customAttributes: [
                    { key: "Delivery Date", value: "2026-08-03" },
                    { key: "Delivery Time", value: "3PM-6PM" },
                  ],
                  fulfillments: [
                    { trackingInfo: [{ number: "TRK123", url: "https://track.example.com/TRK123" }] },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = (await executeAgentTool("lookup_my_orders", {}, NOW_MANILA_NOON_SAT, {
      threadId: CUSTOMER_GID,
      customerGid: CUSTOMER_GID,
    })) as { ok: boolean; orders?: Array<Record<string, unknown>> };

    expect(result.ok).toBe(true);
    expect(result.orders?.[0]).toMatchObject({
      name: "#3979",
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      deliveryDate: "2026-08-03",
      deliveryTime: "3PM-6PM",
      trackingUrl: "https://track.example.com/TRK123",
    });
    const vars = (graphqlMock.mock.calls[0][1] as { variables: { query: string } }).variables;
    expect(vars.query).toBe("customer_id:778899");
    // No anti-guessing counter: there is nothing to guess here.
    expect(prismaMock.lookupAttempt.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.lookupAttempt.upsert).not.toHaveBeenCalled();
  });

  it("REDACTION: never returns an address, a zip, or a phone number", async () => {
    graphqlMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            orders: {
              nodes: [
                {
                  name: "#3979",
                  shippingAddress: { zip: "1300", address1: "255 Kawit St", phone: "09624224085" },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = (await executeAgentTool("lookup_my_orders", {}, NOW_MANILA_NOON_SAT, {
      customerGid: CUSTOMER_GID,
    })) as { ok: boolean; orders?: unknown };

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.orders);
    expect(serialized).not.toContain("Kawit");
    expect(serialized).not.toContain("09624224085");
    expect(serialized).not.toContain("1300");
  });
});

describe("resolveDeliveryDate (Asia/Manila arithmetic — the LLM never computes dates)", () => {
  it("resolves today with the weekday", () => {
    const result = resolveDeliveryDate({ base: "today" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({
      ok: true,
      isoDate: "2026-08-01",
      weekday: "Saturday",
      weekdayFil: "Sabado",
    });
  });

  it("resolves tomorrow", () => {
    const result = resolveDeliveryDate({ base: "tomorrow" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({ ok: true, isoDate: "2026-08-02", weekday: "Sunday" });
  });

  it("uses Manila for the UTC-evening rollover (11PM Manila is still yesterday in UTC)", () => {
    // 2026-08-01T18:00:00Z = Aug 2, 2:00 AM in Manila.
    const result = resolveDeliveryDate({ base: "today" }, new Date("2026-08-01T18:00:00Z"));
    expect(result).toMatchObject({ ok: true, isoDate: "2026-08-02" });
  });

  it("resolves the NEXT occurrence of a weekday (1-7 days ahead)", () => {
    const friday = resolveDeliveryDate(
      { base: "weekday", weekday: "friday" },
      NOW_MANILA_NOON_SAT,
    );
    expect(friday).toMatchObject({ ok: true, isoDate: "2026-08-07", weekday: "Friday" });

    // Asking for Saturday ON a Saturday means next week, never today.
    const saturday = resolveDeliveryDate(
      { base: "weekday", weekday: "saturday" },
      NOW_MANILA_NOON_SAT,
    );
    expect(saturday).toMatchObject({ ok: true, isoDate: "2026-08-08" });
  });

  it("resolves an explicit month/day to this year when still upcoming", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 12, day: 24 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2026-12-24", weekday: "Thursday" });
  });

  it("rolls an already-past explicit month/day to next year", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 1, day: 5 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2027-01-05" });
  });

  it("respects an explicit year", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 2, day: 14, year: 2027 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2027-02-14" });
  });

  it("rejects impossible calendar dates", () => {
    expect(resolveDeliveryDate({ base: "explicit", month: 2, day: 30 }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "explicit", month: 13, day: 1 }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "weekday" }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "explicit" }, NOW_MANILA_NOON_SAT).ok).toBe(false);
  });
});

describe("getAvailableDeliverySlots (direct scheduler call — same engine as the storefront)", () => {
  const RULES = {
    ...DEFAULT_DELIVERY_SCHEDULE_RULES,
    disabledDates: ["2026-08-03"],
  };

  beforeEach(() => {
    vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
    rulesMock.mockResolvedValue(RULES);
    adminMock.mockResolvedValue({ admin: { graphql: vi.fn() } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns not-configured when MESSENGER_SHOP is missing", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
    expect(rulesMock).not.toHaveBeenCalled();
  });

  it("returns the open slots for a selectable date", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({ ok: true, date: "2026-08-02", available: true });
    if (result.ok && result.available) {
      expect(result.slots.map((s) => s.value)).toEqual([
        "9AM-12PM",
        "12PM-3PM",
        "3PM-6PM",
        "6PM-11PM",
      ]);
      expect(result.weekday).toBe("Sunday");
    }
    expect(rulesMock).toHaveBeenCalledWith("hsrwva-nr.myshopify.com", expect.anything());
  });

  it("reports a blocked date with the nearest available dates instead", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-08-03" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.nearestAvailableDates.length).toBeGreaterThan(0);
        expect(result.nearestAvailableDates).not.toContain("2026-08-03");
        expect(result.nearestAvailableDates[0].date >= "2026-08-01").toBe(true);
      }
    }
  });

  it("reports an out-of-window past date as unavailable", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-07-01" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.available).toBe(false);
    }
  });

  it("rejects a malformed date string", async () => {
    const result = await getAvailableDeliverySlots({ date: "bukas" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
  });

  it("still answers (without live counts) when the offline session/admin client fails", async () => {
    adminMock.mockRejectedValue(new Error("no offline session"));
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    expect(rulesMock).toHaveBeenCalledWith("hsrwva-nr.myshopify.com", undefined);
  });

  it("never throws when the rules service fails", async () => {
    rulesMock.mockRejectedValue(new Error("db down"));
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
  });
});
