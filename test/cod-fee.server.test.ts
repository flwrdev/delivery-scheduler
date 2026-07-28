import { describe, expect, it, vi } from "vitest";

import {
  applyCodFeeToOrder,
  isCashOnDeliveryOrder,
} from "../app/services/cod-fee.server";

const ORDER_ID = "gid://shopify/Order/1";
const VARIANT_ID = "gid://shopify/ProductVariant/70";
const CALCULATED_ID = "gid://shopify/CalculatedOrder/9";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function buildAdmin(responses: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    graphql: vi.fn(async (query: string) => {
      const key = Object.keys(responses).find((k) => query.includes(k));
      calls.push(key ?? "unknown");
      if (!key) throw new Error(`unexpected query: ${query.slice(0, 80)}`);
      return jsonResponse(responses[key]);
    }),
  };
}

describe("isCashOnDeliveryOrder", () => {
  it("matches the merchant-named manual COD method", () => {
    expect(
      isCashOnDeliveryOrder({
        payment_gateway_names: ["Cash on Delivery (COD)"],
      }),
    ).toBe(true);
    expect(isCashOnDeliveryOrder({ payment_gateway_names: ["COD"] })).toBe(
      true,
    );
  });

  it("does not match other gateways or malformed payloads", () => {
    expect(
      isCashOnDeliveryOrder({
        payment_gateway_names: ["Xendit - Cards, Bank Transfers, QR, Ewallets"],
      }),
    ).toBe(false);
    expect(isCashOnDeliveryOrder({ payment_gateway_names: "COD" })).toBe(false);
    expect(isCashOnDeliveryOrder({})).toBe(false);
  });
});

describe("applyCodFeeToOrder", () => {
  it("adds the fee variant via begin → add → commit", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [{ sku: "ROSE-24" }] } } },
      },
      CodFeeVariantLookup: {
        data: { productVariants: { nodes: [{ id: VARIANT_ID }] } },
      },
      CodFeeOrderEditBegin: {
        data: {
          orderEditBegin: {
            calculatedOrder: { id: CALCULATED_ID },
            userErrors: [],
          },
        },
      },
      CodFeeOrderEditAddVariant: {
        data: { orderEditAddVariant: { userErrors: [] } },
      },
      CodFeeOrderEditCommit: {
        data: {
          orderEditCommit: { order: { id: ORDER_ID }, userErrors: [] },
        },
      },
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result).toEqual({ ok: true, skipped: false, errors: [] });
    expect(admin.calls).toEqual([
      "CodFeeOrderLineItemSkus",
      "CodFeeVariantLookup",
      "CodFeeOrderEditBegin",
      "CodFeeOrderEditAddVariant",
      "CodFeeOrderEditCommit",
    ]);
  });

  it("skips an order that already carries the fee SKU (redelivery-safe)", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [{ sku: "COD-FEE" }] } } },
      },
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(admin.calls).toEqual(["CodFeeOrderLineItemSkus"]);
  });

  it("fails without mutating when the fee variant does not exist", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [] } } },
      },
      CodFeeVariantLookup: { data: { productVariants: { nodes: [] } } },
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("sku:COD-FEE");
    expect(admin.calls).toEqual([
      "CodFeeOrderLineItemSkus",
      "CodFeeVariantLookup",
    ]);
  });

  it("stops after begin userErrors without adding or committing", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [] } } },
      },
      CodFeeVariantLookup: {
        data: { productVariants: { nodes: [{ id: VARIANT_ID }] } },
      },
      CodFeeOrderEditBegin: {
        data: {
          orderEditBegin: {
            calculatedOrder: null,
            userErrors: [{ message: "Order cannot be edited" }],
          },
        },
      },
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "orderEditBegin: Order cannot be edited",
    ]);
    expect(admin.calls).toEqual([
      "CodFeeOrderLineItemSkus",
      "CodFeeVariantLookup",
      "CodFeeOrderEditBegin",
    ]);
  });

  it("never throws on a network failure", async () => {
    const admin = {
      graphql: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    };

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("socket hang up");
  });
});
