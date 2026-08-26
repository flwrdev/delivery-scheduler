import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-22 Phase B: the shared executor's NEW retry-idempotency behaviors (the
// pre-existing op behaviors stay pinned by the route-level tests, e.g.
// orders-reschedule-capacity.test.ts):
// - cancel: "already cancelled" on a re-run reports success;
// - markFulfilled: nothing fulfillable + displayFulfillmentStatus FULFILLED
//   reports success ("Already fulfilled"), while a genuinely unfulfillable
//   order still reports the failure;
// - reschedule: metafields EXACTLY at the target skip the write (no duplicate
//   history), while a drifted spelling still gets the repair write.

const { rescheduleMock, recordLalamoveMock, rulesMock } = vi.hoisted(() => ({
  rescheduleMock: vi.fn(),
  recordLalamoveMock: vi.fn(),
  rulesMock: vi.fn(),
}));

vi.mock("../app/services/reschedule-order-delivery.server", () => ({
  rescheduleOrderDelivery: rescheduleMock,
}));

vi.mock("../app/services/lalamove-tracking.server", () => ({
  recordLalamoveOrderId: recordLalamoveMock,
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRules: rulesMock,
}));

import { executeBulkAction } from "../app/services/bulk-actions.server";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_1 = "gid://shopify/Order/1001";

function gqlResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(responder: (query: string, variables?: Record<string, unknown>) => unknown) {
  return {
    graphql: vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) =>
      gqlResponse(responder(query, options?.variables)),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rulesMock.mockResolvedValue({ timezone: "Asia/Manila" });
  rescheduleMock.mockResolvedValue({
    ok: true,
    historySync: "ok",
    attributeSync: "ok",
    tagSync: "ok",
    canonicalErrors: { graphql: [], user: [] },
  });
});

describe("executeBulkAction — cancel retry idempotency", () => {
  it("reports an already-cancelled order as success on a re-run", async () => {
    const admin = makeAdmin(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ message: "Order has already been canceled." }],
        },
      },
    }));
    const results = await executeBulkAction(
      admin,
      SHOP,
      { op: "cancel", reason: "CUSTOMER", restock: false, notifyCustomer: false, staffNote: null },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already cancelled." },
    ]);
  });

  it("still reports a genuine cancel failure as failure", async () => {
    const admin = makeAdmin(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ message: "Payment cannot be refunded." }],
        },
      },
    }));
    const results = await executeBulkAction(
      admin,
      SHOP,
      { op: "cancel", reason: "CUSTOMER", restock: false, notifyCustomer: false, staffNote: null },
      [ORDER_1],
    );
    expect(results[0].success).toBe(false);
  });
});

describe("executeBulkAction — markFulfilled retry idempotency", () => {
  function fulfillmentAdmin(displayStatus: string) {
    return makeAdmin((query) => {
      if (query.includes("BatchFulfillmentOrders")) {
        return {
          data: {
            o0: {
              id: ORDER_1,
              displayFulfillmentStatus: displayStatus,
              fulfillmentOrders: { nodes: [] },
            },
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
  }

  it("nothing fulfillable + FULFILLED → success (a crash-retry re-run)", async () => {
    const results = await executeBulkAction(
      fulfillmentAdmin("FULFILLED"),
      SHOP,
      { op: "markFulfilled", trackingUrl: "", notifyCustomer: false, lalamoveOrderId: "" },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already fulfilled." },
    ]);
  });

  it("nothing fulfillable + NOT fulfilled → still the original failure", async () => {
    const results = await executeBulkAction(
      fulfillmentAdmin("UNFULFILLED"),
      SHOP,
      { op: "markFulfilled", trackingUrl: "", notifyCustomer: false, lalamoveOrderId: "" },
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: false, message: "No fulfillable items remaining." },
    ]);
  });
});

describe("executeBulkAction — reschedule skip guard", () => {
  function stateAdmin(metaDate: string | null, metaSlot: string | null) {
    return makeAdmin((query) => {
      if (query.includes("RescheduleOrderStates")) {
        return {
          data: {
            nodes: [
              {
                id: ORDER_1,
                tags: [],
                customAttributes: [],
                currentDeliveryDate: metaDate == null ? null : { value: metaDate },
                currentDeliveryTimeSlot: metaSlot == null ? null : { value: metaSlot },
                rescheduleHistory: null,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
  }

  const params = {
    op: "reschedule" as const,
    date: "2026-08-30",
    timeSlot: "9AM-12PM",
    requestedAt: "2026-08-27T00:00:00.000Z",
    shopTimezone: "Asia/Manila",
  };

  it("metafields EXACTLY at the target → skip, success, no write", async () => {
    const results = await executeBulkAction(
      stateAdmin("2026-08-30", "9AM-12PM"),
      SHOP,
      params,
      [ORDER_1],
    );
    expect(results).toEqual([
      { orderId: ORDER_1, success: true, message: "Already at the selected date and slot." },
    ]);
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("a DRIFTED spelling still gets the repair write (pinned §5 behavior)", async () => {
    const results = await executeBulkAction(
      stateAdmin("2026-08-30", "9:00AM - 12:00PM"),
      SHOP,
      params,
      [ORDER_1],
    );
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    expect(results[0].success).toBe(true);
    expect(results[0].message).toBeUndefined();
  });

  it("the requestedAt snapshot flows into the write (stable across chunks/retries)", async () => {
    await executeBulkAction(stateAdmin("2026-08-20", "3PM-6PM"), SHOP, params, [ORDER_1]);
    expect(rescheduleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestedAt: "2026-08-27T00:00:00.000Z",
        source: "merchant",
        shopTimezone: "Asia/Manila",
      }),
    );
  });
});
