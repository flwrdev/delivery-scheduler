import { beforeEach, describe, expect, it, vi } from "vitest";

// Payload extraction (attributes, COD detection, checkout time) runs real;
// only the Shopify auth and sync seams are mocked.

const { webhookAuthMock, syncMock } = vi.hoisted(() => ({
  webhookAuthMock: vi.fn(),
  syncMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: webhookAuthMock },
}));

vi.mock("../app/services/order-delivery-sync.server", () => ({
  syncOrderDelivery: syncMock,
}));

import { action } from "../app/routes/webhooks.orders.create";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_GID = "gid://shopify/Order/111";
const admin = { graphql: vi.fn() };

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

async function callAction(
  payload: Record<string, unknown>,
  context: Record<string, unknown> = { admin },
): Promise<Response> {
  webhookAuthMock.mockResolvedValue({ payload, shop: SHOP, ...context });
  const request = new Request("https://app.example.com/webhooks/orders/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return (await action({ request } as never)) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  syncMock.mockResolvedValue({ ok: true, errors: [] });
});

describe("webhooks.orders.create", () => {
  it("acks without syncing when there is nothing to sync (no attrs, not COD)", async () => {
    const res = await callAction(
      deliveryPayload({ note_attributes: [], payment_gateway_names: ["shopify_payments"] }),
    );
    expect(res.status).toBe(200);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("syncs inline with the order's checkout time", async () => {
    const res = await callAction(deliveryPayload());
    expect(res.status).toBe(200);
    expect(syncMock).toHaveBeenCalledWith(admin, {
      shop: SHOP,
      orderId: ORDER_GID,
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      // 4:50 PM Manila — the order's created_at, never webhook processing time.
      checkoutTime: new Date("2026-08-26T08:50:00.000Z"),
      needsCodFee: true,
    });
  });

  it("syncs a COD-only order (no delivery attrs) as fee-only", async () => {
    const res = await callAction(deliveryPayload({ note_attributes: [] }));
    expect(res.status).toBe(200);
    expect(syncMock).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ deliveryDate: null, timeSlot: null, needsCodFee: true }),
    );
  });

  it("answers 500 when a step fails so Shopify redelivers", async () => {
    syncMock.mockResolvedValue({ ok: false, errors: ["tags: network"] });
    const res = await callAction(deliveryPayload());
    expect(res.status).toBe(500);
  });

  it("acks 200 without syncing when there is no offline session", async () => {
    const res = await callAction(deliveryPayload(), { admin: undefined });
    expect(res.status).toBe(200);
    expect(syncMock).not.toHaveBeenCalled();
  });
});
