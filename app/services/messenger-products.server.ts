// Live Shopify product lookup for the FlowerCart Messenger agent (phase 5).
//
// Locked decision #8: product discovery uses the Generic Template carousel with
// postback payloads carrying the VARIANT id, and LIVE Admin GraphQL prices —
// never the delayed Meta catalog sync. Hard rule: re-validate price and
// availability at postback time (the customer may be tapping a three-day-old
// card) — that is what getVariantLive is for.
//
// Same admin-client pattern as the slots tool: unauthenticated.admin(MESSENGER_SHOP).
// Log hygiene: ids, counts, error strings — never full product payloads.

import { unauthenticated } from "../shopify.server";

// Master doc: carousel caps at 8 elements.
export const PRODUCT_CAROUSEL_LIMIT = 8;

export interface MessengerProduct {
  productTitle: string;
  variantId: string;
  variantTitle?: string;
  pricePhp: number;
  imageUrl?: string;
  url?: string;
  available: boolean;
}

export interface SearchShopProductsInput {
  query?: string;
  minPricePhp?: number;
  maxPricePhp?: number;
}

export type SearchShopProductsResult =
  | { ok: true; products: MessengerProduct[]; note: string }
  | { ok: false; error: string };

export type GetVariantLiveResult =
  | { ok: true; product: MessengerProduct }
  | { ok: false; error: string };

const PRODUCTS_NOTE =
  "Live Shopify prices in PHP. A product carousel is sent to the customer automatically after your reply — do not list the products or prices in your text.";

interface AdminGraphqlClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

async function getAdminClient(): Promise<
  { ok: true; admin: AdminGraphqlClient } | { ok: false; error: string }
> {
  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return { ok: false, error: "MESSENGER_SHOP is not configured on this environment." };
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { ok: true, admin: admin as unknown as AdminGraphqlClient };
  } catch (error) {
    return {
      ok: false,
      error: `Shopify admin client unavailable: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    };
  }
}

const SEARCH_PRODUCTS_QUERY = `#graphql
  query MessengerProductSearch($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      nodes {
        title
        onlineStoreUrl
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
        variants(first: 1) {
          nodes {
            id
            title
            price
            availableForSale
          }
        }
      }
    }
  }
`;

interface ProductNode {
  title?: string;
  onlineStoreUrl?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
  variants?: { nodes?: VariantNode[] };
}

interface VariantNode {
  id?: string;
  title?: string;
  price?: string;
  availableForSale?: boolean;
}

function toProduct(productTitle: string, node: ProductNode, variant: VariantNode): MessengerProduct {
  const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : undefined;
  return {
    productTitle,
    variantId: variant.id ?? "",
    ...(variantTitle ? { variantTitle } : {}),
    pricePhp: Number(variant.price ?? 0),
    ...(node.featuredMedia?.preview?.image?.url
      ? { imageUrl: node.featuredMedia.preview.image.url }
      : {}),
    ...(node.onlineStoreUrl ? { url: node.onlineStoreUrl } : {}),
    available: variant.availableForSale === true,
  };
}

export async function searchShopProducts(
  input: SearchShopProductsInput,
): Promise<SearchShopProductsResult> {
  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error };
  }

  const terms: string[] = ["status:active"];
  const keyword = input.query?.trim();
  if (keyword) {
    // Escape quotes; match on title.
    terms.push(`title:*${keyword.replace(/["\\]/g, "")}*`);
  }
  if (typeof input.minPricePhp === "number" && input.minPricePhp > 0) {
    terms.push(`price:>=${input.minPricePhp}`);
  }
  if (typeof input.maxPricePhp === "number" && input.maxPricePhp > 0) {
    terms.push(`price:<=${input.maxPricePhp}`);
  }

  try {
    const response = await client.admin.graphql(SEARCH_PRODUCTS_QUERY, {
      variables: { first: PRODUCT_CAROUSEL_LIMIT, query: terms.join(" ") },
    });
    const body = (await response.json()) as {
      data?: { products?: { nodes?: ProductNode[] } };
    };
    const nodes = body.data?.products?.nodes ?? [];
    const products: MessengerProduct[] = [];
    for (const node of nodes) {
      const variant = node.variants?.nodes?.[0];
      if (!variant?.id || !node.title) {
        continue;
      }
      products.push(toProduct(node.title, node, variant));
    }
    console.log(`[messenger-products] search matched ${products.length} product(s)`);
    return { ok: true, products, note: PRODUCTS_NOTE };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.warn(`[messenger-products] search failed: ${detail}`);
    return { ok: false, error: `Product search failed: ${detail}` };
  }
}

const VARIANT_LIVE_QUERY = `#graphql
  query MessengerVariantLive($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        price
        availableForSale
        product {
          title
          onlineStoreUrl
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
        }
      }
    }
  }
`;

/** Re-validate a variant LIVE at postback time — never trust the rendered card. */
export async function getVariantLive(variantId: string): Promise<GetVariantLiveResult> {
  const id = variantId.trim();
  if (!id.startsWith("gid://shopify/ProductVariant/")) {
    return { ok: false, error: "variant_id must be a gid://shopify/ProductVariant/... id." };
  }

  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error };
  }

  try {
    const response = await client.admin.graphql(VARIANT_LIVE_QUERY, { variables: { id } });
    const body = (await response.json()) as {
      data?: {
        node?: (VariantNode & { product?: ProductNode }) | null;
      };
    };
    const node = body.data?.node;
    if (!node?.id || !node.product?.title) {
      return { ok: false, error: "Variant not found (it may have been removed from the store)." };
    }
    return { ok: true, product: toProduct(node.product.title, node.product, node) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.warn(`[messenger-products] variant lookup failed: ${detail}`);
    return { ok: false, error: `Variant lookup failed: ${detail}` };
  }
}
