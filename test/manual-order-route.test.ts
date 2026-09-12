import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /app/manual-order — the Messenger/Instagram order form. Same mock idiom
// as test/apps-schedule-rules-route.test.ts: auth, the rules service, and the
// COD-fee lookup are mocked; slot resolution and custom-time canonicalization
// (app/lib/slot-value.ts) are REAL.

const { adminAuthMock, getRulesMock, findCodFeeMock } = vi.hoisted(() => ({
  adminAuthMock: vi.fn(),
  getRulesMock: vi.fn(),
  findCodFeeMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: adminAuthMock },
}));
vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRules: getRulesMock,
}));
vi.mock("../app/services/cod-fee.server", () => ({
  findCodFeeVariant: findCodFeeMock,
}));

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";
import { action } from "../app/routes/app.manual-order";

const SHOP = "hsrwva-nr.myshopify.com";
const COD_VARIANT = { id: "gid://shopify/ProductVariant/48139537252539", sku: "COD-FEE", price: "70.00", productId: "gid://shopify/Product/8489181282491" };

function graphqlMock() {
  return vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    if (query.includes("draftOrderCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", invoiceUrl: "https://inv", totalPriceSet: { shopMoney: { amount: "1628.00" } } },
              userErrors: [],
            },
          },
        }),
      );
    }
    if (query.includes("draftOrderComplete")) {
      return new Response(
        JSON.stringify({
          data: {
            draftOrderComplete: {
              draftOrder: { order: { id: "gid://shopify/Order/7", name: "#4400" } },
              userErrors: [],
            },
          },
        }),
      );
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)} ${JSON.stringify(opts)}`);
  });
}

function formRequest(fields: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://app.test/app/manual-order", { method: "POST", body: fd });
}

const BASE_FIELDS = {
  source: "messenger",
  variantId: "gid://shopify/ProductVariant/1",
  quantity: "1",
  recipientName: "Shayne Ochoco",
  address1: "SMDC Light Residences",
  city: "Mandaluyong",
  email: "shayne@example.com",
  phone: "09491347551",
  deliveryDate: "2026-09-08",
  deliveryFee: "159",
};

let admin: { graphql: ReturnType<typeof graphqlMock> };

beforeEach(() => {
  admin = { graphql: graphqlMock() };
  adminAuthMock.mockResolvedValue({ admin, session: { shop: SHOP } });
  getRulesMock.mockResolvedValue(DEFAULT_DELIVERY_SCHEDULE_RULES);
  findCodFeeMock.mockResolvedValue({ variant: COD_VARIANT, errors: [] });
});

function draftInput() {
  const call = admin.graphql.mock.calls.find(([q]) => q.includes("draftOrderCreate"));
  return (call?.[1] as { variables: { input: Record<string, unknown> } }).variables.input;
}

describe("POST /app/manual-order — COD order with a custom time", () => {
  it("adds the COD-FEE line, canonicalizes the typed time, and completes the draft with payment pending", async () => {
    const res = await action({
      request: formRequest({ ...BASE_FIELDS, deliveryTime: "8:00 PM", payment: "cod" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: "order", payment: "cod", orderName: "#4400" });

    const input = draftInput();
    expect(input.lineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      { variantId: COD_VARIANT.id, quantity: 1 },
    ]);
    expect(input.customAttributes).toEqual(
      expect.arrayContaining([
        { key: "Delivery Date", value: "2026-09-08" },
        { key: "Delivery Time", value: "8PM" },
      ]),
    );
    expect(input.tags).toEqual(["2026-09-08", "8PM", "source:messenger"]);
    expect(input.shippingLine).toEqual({ title: "LALAMOVE", priceWithCurrency: { amount: 159, currencyCode: "PHP" } });
    expect(String(input.note)).toContain("Payment: Cash on Delivery");

    const complete = admin.graphql.mock.calls.find(([q]) => q.includes("draftOrderComplete"));
    expect(complete?.[1]).toEqual({ variables: { id: "gid://shopify/DraftOrder/1", source: "messenger", paymentPending: true } });
  });

  it("rejects COD when the store has no COD-FEE variant, before any Shopify write", async () => {
    findCodFeeMock.mockResolvedValue({ variant: null, errors: [] });
    const res = await action({
      request: formRequest({ ...BASE_FIELDS, deliveryTime: "8PM", payment: "cod" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});

describe("POST /app/manual-order — slot handling", () => {
  it("writes a configured slot as configured, tolerant of spelling", async () => {
    await action({ request: formRequest({ ...BASE_FIELDS, deliveryTime: "3pm - 6pm", payment: "gcash_paid" }), params: {}, context: {} } as never);
    const input = draftInput();
    expect(input.tags).toEqual(["2026-09-08", "3PM-6PM", "source:messenger"]);
    const complete = admin.graphql.mock.calls.find(([q]) => q.includes("draftOrderComplete"));
    expect(complete?.[1]).toEqual({ variables: { id: "gid://shopify/DraftOrder/1", source: "messenger", paymentPending: false } });
  });

  it("rejects a time that is neither a configured slot nor a time", async () => {
    const res = await action({ request: formRequest({ ...BASE_FIELDS, deliveryTime: "evening", payment: "gcash_paid" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("keeps a pending GCash order as a draft with the invoice link", async () => {
    const res = await action({ request: formRequest({ ...BASE_FIELDS, deliveryTime: "9AM-12PM", payment: "gcash_pending" }), params: {}, context: {} } as never);
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: "draft", payment: "gcash_pending", invoiceUrl: "https://inv" });
    expect(admin.graphql.mock.calls.some(([q]) => q.includes("draftOrderComplete"))).toBe(false);
  });
});
