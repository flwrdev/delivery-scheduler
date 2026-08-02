import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminMock } = vi.hoisted(() => ({
  adminMock: vi.fn(),
}));

// Fully mocked: the real shopify.server initializes Prisma session storage,
// which cannot run inside vitest.
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

import {
  fuzzyTitleSimilarity,
  getVariantLive,
  productDescriptionText,
  searchShopProducts,
} from "../app/services/messenger-products.server";

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

describe("productDescriptionText (phase 9 — inclusions reach the LLM)", () => {
  it("strips tags, turns list items into '-' bullets, and unescapes entities", () => {
    const html =
      "<p>A dreamy pastel bouquet.</p>" +
      "<p><strong>BLOOMS:</strong></p>" +
      "<ul><li>10 Pink carnation</li><li>8 Pink rose &amp; baby&#39;s breath</li></ul>" +
      "<p>SIZE:&nbsp;Medium</p>";
    const text = productDescriptionText(html);
    expect(text).toContain("A dreamy pastel bouquet.");
    expect(text).toContain("BLOOMS:");
    expect(text).toContain("- 10 Pink carnation");
    expect(text).toContain("- 8 Pink rose & baby's breath");
    expect(text).toContain("SIZE: Medium");
    expect(text).not.toContain("<");
    expect(text).not.toContain("&amp;");
  });

  it("collapses runs of whitespace and blank lines", () => {
    const text = productDescriptionText("<p>  Hello    world </p>\n\n\n<p>  Next   line </p>");
    expect(text).toBe("Hello world\nNext line");
  });

  it("caps at 1200 chars keeping the START (BLOOMS bullets live near the top)", () => {
    const html = `<p>BLOOMS: 10 Pink carnation</p><p>${"x".repeat(3000)}</p>`;
    const text = productDescriptionText(html);
    expect(text.length).toBe(1200);
    expect(text.startsWith("BLOOMS: 10 Pink carnation")).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(productDescriptionText("")).toBe("");
  });
});

describe("fuzzyTitleSimilarity (phase 9 — typo tolerance helper)", () => {
  it("scores an exact match (case/punctuation-insensitive) as 1", () => {
    expect(fuzzyTitleSimilarity("Pastel Dreams", "pastel dreams!")).toBe(1);
  });

  it("scores the live typo 'pastil dream' vs 'Pastel Dreams' above the 0.55 threshold", () => {
    expect(fuzzyTitleSimilarity("pastil dream", "Pastel Dreams")).toBeGreaterThanOrEqual(0.55);
  });

  it("tolerates one-to-two edit typos", () => {
    expect(fuzzyTitleSimilarity("swet heart", "Sweet Heart")).toBeGreaterThanOrEqual(0.55);
    expect(fuzzyTitleSimilarity("autum mornin", "Autumn Morning")).toBeGreaterThanOrEqual(0.55);
  });

  it("scores unrelated titles below the threshold", () => {
    expect(fuzzyTitleSimilarity("pastil dream", "Sunflower Sunshine")).toBeLessThan(0.55);
    expect(fuzzyTitleSimilarity("chocolates", "Red Roses Dozen")).toBeLessThan(0.55);
  });
});

describe("searchShopProducts — descriptions reach the tool result (phase 9)", () => {
  it("requests descriptionHtml and maps it into a capped plain-text description", async () => {
    graphqlMock.mockResolvedValue(
      jsonResponse({
        data: {
          products: {
            nodes: [
              productNode({
                descriptionHtml:
                  "<p>Sweet!</p><p>BLOOMS: 10 Pink carnation, 8 Pink rose</p>",
              }),
            ],
          },
        },
      }),
    );

    const result = await searchShopProducts({ query: "sweet" });
    const [query] = graphqlMock.mock.calls[0];
    expect(query).toContain("descriptionHtml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.products[0].description).toBe(
        "Sweet!\nBLOOMS: 10 Pink carnation, 8 Pink rose",
      );
    }
  });

  it("omits description when the product has none", async () => {
    graphqlMock.mockResolvedValue(
      jsonResponse({ data: { products: { nodes: [productNode()] } } }),
    );
    const result = await searchShopProducts({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.products[0].description).toBeUndefined();
    }
  });
});

describe("searchShopProducts — typo-tolerant fuzzy fallback (phase 9)", () => {
  function titlesResponse(titles: string[]) {
    return jsonResponse({
      data: { products: { nodes: titles.map((title) => ({ title })) } },
    });
  }

  it("resolves 'pastil dream' to 'Pastel Dreams' via the titles pool + refetch", async () => {
    graphqlMock
      // 1) keyword search — walang tama.
      .mockResolvedValueOnce(jsonResponse({ data: { products: { nodes: [] } } }))
      // 2) titles-only pool.
      .mockResolvedValueOnce(
        titlesResponse(["Sweet Heart", "Pastel Dreams", "Sunflower Sunshine"]),
      )
      // 3) full refetch ng best guesses.
      .mockResolvedValueOnce(
        jsonResponse({
          data: { products: { nodes: [productNode({ title: "Pastel Dreams" })] } },
        }),
      );

    const result = await searchShopProducts({ query: "pastil dream" });

    expect(graphqlMock).toHaveBeenCalledTimes(3);
    // Titles pool: first 100, active lang, walang title filter.
    const [poolQuery, poolOptions] = graphqlMock.mock.calls[1];
    expect(poolQuery).toContain('status:active');
    expect(poolOptions.variables.first).toBe(100);
    // Refetch: exact-title OR terms.
    const { variables } = graphqlMock.mock.calls[2][1];
    expect(variables.query).toContain('title:"Pastel Dreams"');
    expect(variables.query).toContain("status:active");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fuzzyMatched).toBe(true);
      expect(result.products).toHaveLength(1);
      expect(result.products[0].productTitle).toBe("Pastel Dreams");
      expect(result.note).toContain("confirm the product name");
    }
  });

  it("keeps the customer's price bounds in the fuzzy refetch", async () => {
    graphqlMock
      .mockResolvedValueOnce(jsonResponse({ data: { products: { nodes: [] } } }))
      .mockResolvedValueOnce(titlesResponse(["Pastel Dreams"]))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { products: { nodes: [productNode({ title: "Pastel Dreams" })] } },
        }),
      );

    await searchShopProducts({ query: "pastil dream", minPricePhp: 500, maxPricePhp: 1500 });
    const { variables } = graphqlMock.mock.calls[2][1];
    expect(variables.query).toContain("price:>=500");
    expect(variables.query).toContain("price:<=1500");
  });

  it("does NOT fire the fallback when the keyword search found products", async () => {
    graphqlMock.mockResolvedValue(
      jsonResponse({ data: { products: { nodes: [productNode()] } } }),
    );
    const result = await searchShopProducts({ query: "sweet" });
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fuzzyMatched).toBeUndefined();
    }
  });

  it("does NOT fire the fallback when no keyword was given (budget-only search)", async () => {
    graphqlMock.mockResolvedValue(jsonResponse({ data: { products: { nodes: [] } } }));
    const result = await searchShopProducts({ maxPricePhp: 1000 });
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.products).toHaveLength(0);
    }
  });

  it("returns zero products (no refetch) when nothing scores above the threshold", async () => {
    graphqlMock
      .mockResolvedValueOnce(jsonResponse({ data: { products: { nodes: [] } } }))
      .mockResolvedValueOnce(titlesResponse(["Sunflower Sunshine", "Red Roses Dozen"]));

    const result = await searchShopProducts({ query: "chocolates" });
    expect(graphqlMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.products).toHaveLength(0);
      expect(result.fuzzyMatched).toBeUndefined();
    }
  });

  it("degrades to ok:false without throwing when the fallback query rejects", async () => {
    graphqlMock
      .mockResolvedValueOnce(jsonResponse({ data: { products: { nodes: [] } } }))
      .mockRejectedValueOnce(new Error("boom sa fallback"));
    const result = await searchShopProducts({ query: "pastil dream" });
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
