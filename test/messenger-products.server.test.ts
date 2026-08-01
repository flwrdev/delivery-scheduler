import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminMock } = vi.hoisted(() => ({
  adminMock: vi.fn(),
}));

// Fully mocked: the real shopify.server initializes Prisma session storage,
// which cannot run inside vitest.
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

import { getVariantLive, searchShopProducts } from "../app/services/messenger-products.server";

const graphqlMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function productNode(overrides: Record<string, unknown> = {}) {
  return {
    title: "Sweet Heart",
    onlineStoreUrl: "https://flowercart.store/products/sweet-heart",
    featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/sh.jpg" } } },
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/111",
          title: "Default Title",
          price: "799.00",
          availableForSale: true,
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
  graphqlMock.mockReset();
  adminMock.mockReset();
  adminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("searchShopProducts", () => {
  it("degrades to a designed failure when MESSENGER_SHOP is missing", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    const result = await searchShopProducts({});
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("degrades to a designed failure when the admin client is unavailable", async () => {
    adminMock.mockRejectedValue(new Error("no offline session"));
    const result = await searchShopProducts({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no offline session");
  });

  it("builds the Shopify search query from keyword and price bounds", async () => {
    graphqlMock.mockResolvedValue(jsonResponse({ data: { products: { nodes: [] } } }));

    await searchShopProducts({ query: "rose", minPricePhp: 500, maxPricePhp: 1500 });

    const { variables } = graphqlMock.mock.calls[0][1];
    expect(variables.first).toBe(8);
    expect(variables.query).toContain("status:active");
    expect(variables.query).toContain("title:*rose*");
    expect(variables.query).toContain("price:>=500");
    expect(variables.query).toContain("price:<=1500");
  });

  it("maps product nodes to carousel-ready products with live prices", async () => {
    graphqlMock.mockResolvedValue(
      jsonResponse({
        data: {
          products: {
            nodes: [
              productNode(),
              // Walang variant id — dapat laktawan.
              productNode({ title: "Broken", variants: { nodes: [{}] } }),
            ],
          },
        },
      }),
    );

    const result = await searchShopProducts({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.products).toHaveLength(1);
      expect(result.products[0]).toMatchObject({
        productTitle: "Sweet Heart",
        variantId: "gid://shopify/ProductVariant/111",
        pricePhp: 799,
        imageUrl: "https://cdn.shopify.com/sh.jpg",
        url: "https://flowercart.store/products/sweet-heart",
        available: true,
      });
      // "Default Title" ay hindi tunay na variant title — dapat wala.
      expect(result.products[0].variantTitle).toBeUndefined();
    }
  });

  it("returns ok:false without throwing when the GraphQL call rejects", async () => {
    graphqlMock.mockRejectedValue(new Error("boom"));
    const result = await searchShopProducts({});
    expect(result.ok).toBe(false);
  });
});

describe("getVariantLive", () => {
  it("rejects a payload that is not a ProductVariant gid", async () => {
    const result = await getVariantLive("111");
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("re-validates the variant live and returns the current price", async () => {
    graphqlMock.mockResolvedValue(
      jsonResponse({
        data: {
          node: {
            id: "gid://shopify/ProductVariant/111",
            title: "Default Title",
            price: "899.00",
            availableForSale: true,
            product: productNode(),
          },
        },
      }),
    );

    const result = await getVariantLive("gid://shopify/ProductVariant/111");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Live price (899) ang bumalik, hindi ang lumang card price.
      expect(result.product.pricePhp).toBe(899);
      expect(result.product.productTitle).toBe("Sweet Heart");
      expect(result.product.available).toBe(true);
    }
  });

  it("reports a removed variant as an error the agent can apologize for", async () => {
    graphqlMock.mockResolvedValue(jsonResponse({ data: { node: null } }));
    const result = await getVariantLive("gid://shopify/ProductVariant/999");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain("not found");
  });
});
