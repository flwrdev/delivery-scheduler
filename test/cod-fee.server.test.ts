import { describe, expect, it, vi } from "vitest";

import {
  applyCodFeeToOrder,
  findCodFeeVariant,
  isCashOnDeliveryOrder,
} from "../app/services/cod-fee.server";

const ORDER_ID = "gid://shopify/Order/1";
const VARIANT_ID = "gid://shopify/ProductVariant/70";
const OTHER_VARIANT_ID = "gid://shopify/ProductVariant/71";
const PRODUCT_ID = "gid://shopify/Product/7";
const CALCULATED_ID = "gid://shopify/CalculatedOrder/9";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

// A response value may be an array = one body per call (the last one repeats),
// so paginated line-item scans can be scripted page by page.
function buildAdmin(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const variables: Array<Record<string, unknown> | undefined> = [];
  const queues: Record<string, unknown[]> = {};
  return {
    calls,
    variables,
    graphql: vi.fn(
      async (
        query: string,
        options?: { variables?: Record<string, unknown> },
      ) => {
        const key = Object.keys(responses).find((k) => query.includes(k));
        calls.push(key ?? "unknown");
        variables.push(options?.variables);
        if (!key) throw new Error(`unexpected query: ${query.slice(0, 80)}`);
        const body = responses[key];
        if (!Array.isArray(body)) {
          return jsonResponse(body);
        }
        queues[key] = queues[key] ?? [...body];
        const queue = queues[key];
        return jsonResponse(queue.length > 1 ? queue.shift() : queue[0]);
      },
    ),
  };
}

function lineItemPage(
  skus: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null },
) {
  return {
    data: {
      order: {
        lineItems: { nodes: skus.map((sku) => ({ sku })), pageInfo },
      },
    },
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
        data: {
          productVariants: {
            nodes: [
              {
                id: VARIANT_ID,
                sku: "COD-FEE",
                price: "70.00",
                product: { id: PRODUCT_ID },
              },
            ],
          },
        },
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
        data: {
          productVariants: {
            nodes: [{ id: VARIANT_ID, sku: "COD-FEE", price: "70.00" }],
          },
        },
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

  // `sku:COD-FEE` search also returns COD-FEE-OLD / FEE-COD (Shopify tokenizes
  // on hyphens) — the wrong variant means a wrong price on the invoice AND a
  // fee line the exact-match redelivery guard can never see again.
  it("adds only the variant whose SKU matches exactly", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [{ sku: "ROSE-24" }] } } },
      },
      CodFeeVariantLookup: {
        data: {
          productVariants: {
            nodes: [
              { id: OTHER_VARIANT_ID, sku: "COD-FEE-OLD", price: "999.00" },
              { id: VARIANT_ID, sku: "COD-FEE", price: "70.00" },
            ],
          },
        },
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

    expect(result.ok).toBe(true);
    const addVariables =
      admin.variables[admin.calls.indexOf("CodFeeOrderEditAddVariant")];
    expect(addVariables?.variantId).toBe(VARIANT_ID);
  });

  it("fails without mutating when only fuzzy SKU matches come back", async () => {
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: {
        data: { order: { lineItems: { nodes: [] } } },
      },
      CodFeeVariantLookup: {
        data: {
          productVariants: {
            nodes: [
              { id: OTHER_VARIANT_ID, sku: "COD-FEE-OLD", price: "999.00" },
              { id: "gid://shopify/ProductVariant/72", sku: "FEE-COD" },
            ],
          },
        },
      },
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("sku:COD-FEE");
    expect(admin.calls).toEqual([
      "CodFeeOrderLineItemSkus",
      "CodFeeVariantLookup",
    ]);
  });

  // The fee line added by a first delivery sits past page 1 on a >100-line
  // order; page-1-only scanning billed the customer ₱140.
  it("finds the fee SKU past the first line item page (redelivery-safe)", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => `ROSE-${i}`);
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: [
        lineItemPage(firstPage, { hasNextPage: true, endCursor: "cursor-1" }),
        lineItemPage(["TULIP-1", "COD-FEE"], { hasNextPage: false }),
      ],
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(admin.calls).toEqual([
      "CodFeeOrderLineItemSkus",
      "CodFeeOrderLineItemSkus",
    ]);
    expect(admin.variables[1]?.after).toBe("cursor-1");
  });

  it("adds nothing and logs when the line item scan hits its bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = buildAdmin({
      CodFeeOrderLineItemSkus: lineItemPage(["ROSE-24"], {
        hasNextPage: true,
        endCursor: "cursor-n",
      }),
    });

    const result = await applyCodFeeToOrder(admin, { orderId: ORDER_ID });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors[0]).toContain("truncated");
    // Bounded at 10 pages, and the truncation is logged — never silently
    // treated as "fee absent".
    expect(admin.calls).toEqual(Array(10).fill("CodFeeOrderLineItemSkus"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("line item scan truncated"),
    );
    warn.mockRestore();
  });
});

describe("findCodFeeVariant", () => {
  it("returns the exact-SKU variant with its price and product id", async () => {
    const admin = buildAdmin({
      CodFeeVariantLookup: {
        data: {
          productVariants: {
            nodes: [
              { id: OTHER_VARIANT_ID, sku: "COD-FEE-2024", price: "120.00" },
              {
                id: VARIANT_ID,
                sku: "COD-FEE",
                price: "70.00",
                product: { id: PRODUCT_ID },
              },
            ],
          },
        },
      },
    });

    const result = await findCodFeeVariant(admin);

    expect(result.errors).toEqual([]);
    expect(result.variant).toEqual({
      id: VARIANT_ID,
      sku: "COD-FEE",
      price: "70.00",
      productId: PRODUCT_ID,
    });
  });

  it("returns no variant when nothing matches the SKU exactly", async () => {
    const admin = buildAdmin({
      CodFeeVariantLookup: {
        data: {
          productVariants: {
            nodes: [{ id: OTHER_VARIANT_ID, sku: "COD-FEE-OLD" }],
          },
        },
      },
    });

    const result = await findCodFeeVariant(admin);

    expect(result.variant).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("surfaces GraphQL errors and never throws", async () => {
    const failing = {
      graphql: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    };

    const result = await findCodFeeVariant(failing);

    expect(result.variant).toBeNull();
    expect(result.errors[0]).toContain("socket hang up");
  });
});
