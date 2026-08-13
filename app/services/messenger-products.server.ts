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

// Phase 9: cap ng plain-text description na ipinapasa sa LLM per product.
// Ang BLOOMS/SIZE/COMES WITH bullets ay nasa unahan ng description, kaya
// keep-the-start ang tamang truncation. 8 results × 1200 chars = bounded.
export const PRODUCT_DESCRIPTION_MAX_CHARS = 1200;

// Phase 9 typo-tolerant fallback: gaano karaming active titles ang kukunin
// para i-fuzzy-match in code (hindi lalampas — bounded ang payload).
const FUZZY_TITLE_POOL_LIMIT = 100;
// Bigram-similarity threshold — "pastil dream" vs "Pastel Dreams" ≈ 0.7.
const FUZZY_MATCH_THRESHOLD = 0.55;
// Ilang typo-guesses lang ang i-o-offer — hindi buong catalog.
const FUZZY_MATCH_LIMIT = 3;

export interface MessengerProduct {
  productTitle: string;
  variantId: string;
  variantTitle?: string;
  pricePhp: number;
  imageUrl?: string;
  url?: string;
  available: boolean;
  /** Plain-text product description (BLOOMS/SIZE/COMES WITH) — capped, LLM-facing. */
  description?: string;
}

export interface SearchShopProductsInput {
  query?: string;
  minPricePhp?: number;
  maxPricePhp?: number;
  /** "price_asc" = cheapest first, "price_desc" = most expensive first. */
  sort?: "price_asc" | "price_desc";
  /** Product tags the result MUST have (color/type/compound), e.g. ["white"], ["red rose"]. */
  tags?: string[];
  /** Product tags to EXCLUDE, e.g. ["roses"] for "ayaw ko ng roses". */
  excludeTags?: string[];
  /** true = search ONLY add-ons (tag "Add-ons"); default/false = bouquets only (excludes add-ons). */
  addons?: boolean;
}

// Shopify's product query has no price sortKey (price lives on variants), so a
// "cheapest / most expensive" ask fetches a bounded pool and sorts IN CODE, then
// returns only the carousel-worth. Bound keeps the Admin call cheap.
const SORT_POOL_LIMIT = 100;

// Merchant-curated best sellers (2026-08, exact titles). Shown as their own
// carousel, ordered as listed here — NOT a Shopify best-selling metric and NOT a
// collection link.
const BEST_SELLER_TITLES = [
  "Autumn Morning",
  "Sweet Heart",
  "California Dreaming",
  "Luxe Noir",
  "Majestic Bouquet",
  "Meadow Fresh",
  "Crimson Whisper",
];
const BEST_SELLER_NOTE =
  "These are the shop's curated best sellers, live prices in PHP. A carousel is sent to the customer automatically after your reply — do not list the names or prices in your text.";

export type SearchShopProductsResult =
  | {
      ok: true;
      products: MessengerProduct[];
      note: string;
      /** True kapag typo-fallback (bigram match sa titles) ang nagbigay ng results. */
      fuzzyMatched?: boolean;
    }
  | { ok: false; error: string };

export type GetVariantLiveResult =
  | { ok: true; product: MessengerProduct }
  | { ok: false; error: string };

const PRODUCTS_NOTE =
  "Live Shopify prices in PHP. A product carousel is sent to the customer automatically after your reply — do not list the products or prices in your text.";

const FUZZY_NOTE_SUFFIX =
  " No exact title match — these are closest-title guesses for a possible typo; confirm the product name with the customer before quoting details as final.";

// Minimal HTML-entity map — sapat para sa Shopify Body HTML (ang numeric
// entities ay hawak ng hiwalay na replace sa baba).
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Shopify Body HTML → bounded plain text para sa LLM: strip tags, unescape
 * entities, collapse whitespace, cap sa PRODUCT_DESCRIPTION_MAX_CHARS
 * (keep-the-start — ang BLOOMS/SIZE/COMES WITH bullets ay nasa unahan).
 * Pure function, exported for tests.
 */
export function productDescriptionText(html: string): string {
  if (!html) {
    return "";
  }
  let text = html
    // Block-level closers at <br> → newline para hindi magdikit ang bullets.
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|table|section)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    // Lahat ng natitirang tags — tanggal.
    .replace(/<[^>]*>/g, " ");
  // Named + numeric entities.
  text = text.replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (entity) => {
    const named = HTML_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) {
      return named;
    }
    const decMatch = /^&#(\d+);$/.exec(entity);
    if (decMatch) {
      return String.fromCodePoint(Number(decMatch[1]));
    }
    const hexMatch = /^&#x([0-9a-f]+);$/i.exec(entity);
    if (hexMatch) {
      return String.fromCodePoint(parseInt(hexMatch[1], 16));
    }
    return entity;
  });
  // Collapse: spaces/tabs sa loob ng linya, tapos sobrang blank lines.
  text = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text.length > PRODUCT_DESCRIPTION_MAX_CHARS
    ? text.slice(0, PRODUCT_DESCRIPTION_MAX_CHARS)
    : text;
}

// Lowercase + tanggal ang punctuation — pareho ang normalization ng query at title.
function normalizeForFuzzy(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(value: string): string[] {
  const compact = value.replace(/\s+/g, "");
  const grams: string[] = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.push(compact.slice(i, i + 2));
  }
  return grams;
}

/**
 * Bigram (Sørensen–Dice) similarity ng dalawang strings, 0..1 — walang bagong
 * dependency, sapat para sa isang-dalawang letra na typo ("pastil dream" vs
 * "Pastel Dreams" ≈ 0.7). Pure function, exported for tests.
 */
export function fuzzyTitleSimilarity(a: string, b: string): number {
  const gramsA = bigrams(normalizeForFuzzy(a));
  const gramsB = bigrams(normalizeForFuzzy(b));
  if (gramsA.length === 0 || gramsB.length === 0) {
    return gramsA.length === gramsB.length ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (const gram of gramsA) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (const gram of gramsB) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      overlap += 1;
    }
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

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
        descriptionHtml
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
  descriptionHtml?: string | null;
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
  // Bounded plain text para sa LLM (BLOOMS/SIZE/COMES WITH) — hindi ito
  // umaabot sa carousel cards, tool-result lang.
  const description = productDescriptionText(node.descriptionHtml ?? "");
  return {
    ...(description ? { description } : {}),
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

// Isang shared na "search query string → mapped products" na daloy — ginagamit
// ng normal search at ng fuzzy refetch. Throws lang sa network/GraphQL failure
// (hinuhuli ng caller — ang exported services ay never throws).
async function runProductSearch(
  admin: AdminGraphqlClient,
  query: string,
  first: number = PRODUCT_CAROUSEL_LIMIT,
): Promise<MessengerProduct[]> {
  const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
    variables: { first, query },
  });
  const body = (await response.json()) as {
    data?: { products?: { nodes?: ProductNode[] } };
  };
  const nodes = body.data?.products?.nodes ?? [];
  const products: MessengerProduct[] = [];
  for (const node of nodes) {
    const variant = node.variants?.nodes?.[0];
    // Skip unpublished/hidden products (no storefront url) — e.g. the internal
    // "COD Fee" line-item product — so they never surface in a customer carousel.
    if (!variant?.id || !node.title || !node.onlineStoreUrl) {
      continue;
    }
    products.push(toProduct(node.title, node, variant));
  }
  return products;
}

// Titles-only pool para sa typo fallback — magaan (walang descriptions/variants),
// naka-cap sa FUZZY_TITLE_POOL_LIMIT.
const FUZZY_TITLES_QUERY = `#graphql
  query MessengerFuzzyTitles($first: Int!) {
    products(first: $first, query: "status:active") {
      nodes {
        title
      }
    }
  }
`;

/** Best fuzzy title guesses (score ≥ threshold, best-first, cap 3) para sa isang typo na keyword. */
async function findFuzzyTitleMatches(
  admin: AdminGraphqlClient,
  keyword: string,
): Promise<string[]> {
  const response = await admin.graphql(FUZZY_TITLES_QUERY, {
    variables: { first: FUZZY_TITLE_POOL_LIMIT },
  });
  const body = (await response.json()) as {
    data?: { products?: { nodes?: Array<{ title?: string }> } };
  };
  const titles = (body.data?.products?.nodes ?? [])
    .map((node) => node.title)
    .filter((title): title is string => Boolean(title));
  const scored = titles
    .map((title) => ({ title, score: fuzzyTitleSimilarity(keyword, title) }))
    .filter((entry) => entry.score >= FUZZY_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, FUZZY_MATCH_LIMIT);
  console.log(
    `[messenger-products] fuzzy fallback scored ${titles.length} title(s), ${scored.length} above threshold`,
  );
  return scored.map((entry) => entry.title);
}

export async function searchShopProducts(
  input: SearchShopProductsInput,
): Promise<SearchShopProductsResult> {
  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error };
  }

  // Hiwalay ang price bounds — ginagamit ulit sila ng fuzzy refetch sa baba.
  const priceTerms: string[] = [];
  if (typeof input.minPricePhp === "number" && input.minPricePhp > 0) {
    priceTerms.push(`price:>=${input.minPricePhp}`);
  }
  if (typeof input.maxPricePhp === "number" && input.maxPricePhp > 0) {
    priceTerms.push(`price:<=${input.maxPricePhp}`);
  }

  const terms: string[] = ["status:active", ...priceTerms];
  // Add-on scope: bouquet browse/sort/reco EXCLUDES add-ons (tag "Add-ons"); the
  // add-on upsell opts in with addons:true to search WITHIN add-ons.
  terms.push(input.addons === true ? "tag:'Add-ons'" : "-tag:'Add-ons'");
  const keyword = input.query?.trim();
  if (keyword) {
    // Escape quotes; match on title.
    terms.push(`title:*${keyword.replace(/["\\]/g, "")}*`);
  }
  // Tag filters — reliable color/type/compound matching (pink, roses, red rose…).
  for (const tag of input.tags ?? []) {
    const clean = tag.trim().replace(/['\\]/g, "");
    if (clean) terms.push(`tag:'${clean}'`);
  }
  for (const tag of input.excludeTags ?? []) {
    const clean = tag.trim().replace(/['\\]/g, "");
    if (clean) terms.push(`-tag:'${clean}'`);
  }

  try {
    // Cheapest / most-expensive: fetch a bounded pool and sort by price in code
    // (Shopify has no product-level price sortKey), then keep the carousel-worth.
    if (input.sort) {
      const pool = await runProductSearch(client.admin, terms.join(" "), SORT_POOL_LIMIT);
      const sorted = [...pool].sort((a, b) =>
        input.sort === "price_asc" ? a.pricePhp - b.pricePhp : b.pricePhp - a.pricePhp,
      );
      console.log(`[messenger-products] sorted ${pool.length} product(s) by ${input.sort}`);
      return { ok: true, products: sorted.slice(0, PRODUCT_CAROUSEL_LIMIT), note: PRODUCTS_NOTE };
    }

    const products = await runProductSearch(client.admin, terms.join(" "));
    console.log(`[messenger-products] search matched ${products.length} product(s)`);
    if (products.length > 0 || !keyword) {
      return { ok: true, products, note: PRODUCTS_NOTE };
    }

    // Phase 9: zero hits sa isang keyword search — baka typo ("pastil dream").
    // Fuzzy-match ang keyword laban sa active titles IN CODE, tapos i-refetch
    // nang buo ang best guesses (kasama pa rin ang price bounds ng customer).
    const fuzzyTitles = await findFuzzyTitleMatches(client.admin, keyword);
    if (fuzzyTitles.length === 0) {
      return { ok: true, products, note: PRODUCTS_NOTE };
    }
    const fuzzyTerms = [
      ...priceTerms,
      "status:active",
      `(${fuzzyTitles.map((title) => `title:"${title.replace(/["\\]/g, "")}"`).join(" OR ")})`,
    ];
    const fuzzyProducts = await runProductSearch(client.admin, fuzzyTerms.join(" "));
    console.log(
      `[messenger-products] fuzzy fallback matched ${fuzzyProducts.length} product(s) for a possible typo`,
    );
    if (fuzzyProducts.length === 0) {
      return { ok: true, products: [], note: PRODUCTS_NOTE };
    }
    return {
      ok: true,
      products: fuzzyProducts,
      note: `${PRODUCTS_NOTE}${FUZZY_NOTE_SUFFIX}`,
      fuzzyMatched: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.warn(`[messenger-products] search failed: ${detail}`);
    return { ok: false, error: `Product search failed: ${detail}` };
  }
}

/**
 * The merchant-curated best sellers (BEST_SELLER_TITLES), live prices/availability,
 * ordered as curated. Fetched by an OR-of-titles query — no Shopify best-selling
 * metric, no collection link. Returned in the SearchShopProductsResult shape so it
 * rides the same carousel path as search_products.
 */
export async function getBestSellers(): Promise<SearchShopProductsResult> {
  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error };
  }
  try {
    const orClause = BEST_SELLER_TITLES.map(
      (title) => `title:"${title.replace(/["\\]/g, "")}"`,
    ).join(" OR ");
    const found = await runProductSearch(client.admin, `status:active (${orClause})`);
    const norm = (value: string) => value.normalize("NFD").toLowerCase().trim();
    // Order by the curated list; append any matched-but-unlisted defensively.
    const ordered = BEST_SELLER_TITLES.map((title) =>
      found.find((product) => norm(product.productTitle) === norm(title)),
    ).filter((product): product is MessengerProduct => Boolean(product));
    const extra = found.filter((product) => !ordered.includes(product));
    console.log(`[messenger-products] best sellers matched ${found.length}/${BEST_SELLER_TITLES.length}`);
    return {
      ok: true,
      products: [...ordered, ...extra].slice(0, PRODUCT_CAROUSEL_LIMIT),
      note: BEST_SELLER_NOTE,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.warn(`[messenger-products] best sellers failed: ${detail}`);
    return { ok: false, error: `Best sellers lookup failed: ${detail}` };
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
          descriptionHtml
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
