import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-22 Phase A: the orders/create webhook is now a THIN receiver — extract,
// upsert the durable task row, enqueue, ack. These tests pin its failure
// contract: the ONLY intentional non-200 is the task-row upsert failing
// (Shopify's own redelivery is then the fallback); everything after the row
// exists is best-effort. Payload extraction (attributes, COD detection,
// checkout time) runs REAL — only the shopify/auth, task-service, and queue
// seams are mocked.

const { webhookAuthMock, upsertMock, processMock, enqueueMock } = vi.hoisted(() => ({
  webhookAuthMock: vi.fn(),
  upsertMock: vi.fn(),
  processMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: webhookAuthMock },
}));

vi.mock("../app/services/delivery-sync-task.server", () => ({
  upsertDeliverySyncTask: upsertMock,
  processDeliverySyncTask: processMock,
}));

vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueDeliverySyncTask: enqueueMock,
}));

import { action } from "../app/routes/webhooks.orders.create";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_GID = "gid://shopify/Order/111";

function deliveryPayload(overrides: Record<string, unknown> = {}) {
  return {
    admin_graphql_api_id: ORDER_GID,
    name: "#1046",
    created_at: "2026-08-26T16:50:00+08:00",
    note_attributes: [
      { name: "Delivery Date", value: "2026-08-27" },
      { name: "Delivery Time", value: "9AM-12PM" },
    ],
    payment_gateway_names: ["cod"],
    ...overrides,
  };
}

async function callAction(payload: Record<string, unknown>): Promise<Response> {
  webhookAuthMock.mockResolvedValue({ payload, shop: SHOP });
  const request = new Request("https://app.example.com/webhooks/orders/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return (await action({ request } as never)) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockResolvedValue({ id: "task-1" });
  enqueueMock.mockResolvedValue({ ok: true, taskName: "t" });
  processMock.mockResolvedValue({ status: "done" });
});

describe("webhooks.orders.create — thin receiver", () => {
  it("acks without a row when there is nothing to sync (no attrs, not COD)", async () => {
    const res = await callAction(
      deliveryPayload({ note_attributes: [], payment_gateway_names: ["shopify_payments"] }),
    );
    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("upserts the durable row with the FROZEN checkout clock, then enqueues", async () => {
    const res = await callAction(deliveryPayload());
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith({
      shop: SHOP,
      shopifyOrderId: ORDER_GID,
      orderName: "#1046",
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      // 4:50 PM Manila — the order's created_at, never webhook processing time.
      checkoutTime: new Date("2026-08-26T08:50:00.000Z"),
      needsCodFee: true,
    });
    expect(enqueueMock).toHaveBeenCalledWith({ taskId: "task-1" });
    expect(processMock).not.toHaveBeenCalled(); // queue took it — no inline work
  });

  it("records a COD-only order (no delivery attrs) as a fee-only task", async () => {
    const res = await callAction(deliveryPayload({ note_attributes: [] }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryDate: null, timeSlot: null, needsCodFee: true }),
    );
  });

  it("processes inline when no queue is configured (dev fallback)", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "nc", notConfigured: true });
    const res = await callAction(deliveryPayload());
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledWith("task-1");
  });

  it("still acks 200 when the inline fallback throws — the sweep is the backstop", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "boom", notConfigured: false });
    processMock.mockRejectedValue(new Error("neon dropped"));
    const res = await callAction(deliveryPayload());
    expect(res.status).toBe(200);
  });

  it("throws when the task-row upsert fails — Shopify redelivery is the fallback", async () => {
    upsertMock.mockRejectedValue(new Error("db down"));
    await expect(callAction(deliveryPayload())).rejects.toThrow("db down");
  });
});
