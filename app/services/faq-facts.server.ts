// Merchant-curated FAQ Q&A pairs, read from the native Shopify "Knowledge
// Base" app's metaobjects (type "shopify--qa-pair") — the SAME content shown
// on https://flowercart.store/pages/faqs. This is the second merchant-
// editable-facts source baked into the agent's cached static system prompt,
// mirroring cod-facts.server.ts's shape exactly: fetch via Admin GraphQL,
// cache in-process with a TTL, and degrade to an empty list (not a thrown
// error) on any failure so a Shopify hiccup means "prompt without this
// section," never a broken turn.
//
// Cached per process for the same reason cod-facts.server.ts is: the system
// prompt is the byte-identical prefix Anthropic caches, so re-deriving it
// per message would be wasteful, and the FAQ content only changes when the
// merchant edits an entry in the Knowledge Base app.

export type FaqFact = {
  question: string;
  answer: string;
};

const FAQ_METAOBJECT_TYPE = "shopify--qa-pair";
const CACHE_TTL_MS = 5 * 60 * 1000;
// Current real count on flowercart.store is 21 — generous headroom, not a
// hard business limit. pageInfo.hasNextPage is checked below so growth past
// this is logged, never silently dropped.
const MAX_FAQS = 50;

const FAQ_QUERY = `#graphql
  query FaqFacts($first: Int!) {
    metaobjects(type: "${FAQ_METAOBJECT_TYPE}", first: $first) {
      nodes {
        fields {
          key
          value
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

let cached: { facts: FaqFact[]; expiresAt: number } | null = null;

/** Test seam — drops the memo so a suite can exercise a fresh fetch. */
export function resetFaqFactsCache(): void {
  cached = null;
}

function toFaqFact(fields: Array<{ key: string; value: string | null }>): FaqFact | null {
  const question = fields.find((field) => field.key === "question")?.value;
  const answer = fields.find((field) => field.key === "answer")?.value;
  if (!question || !answer) return null;
  return { question, answer };
}

export async function loadFaqFacts(now: number = Date.now()): Promise<FaqFact[]> {
  if (cached && cached.expiresAt > now) {
    return cached.facts;
  }

  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return [];
  }

  try {
    // Imported lazily: shopify.server builds Prisma session storage at module
    // load, which this service's vitest suite cannot initialize — a static
    // import here would drag it into that module graph (same reason
    // cod-facts.server.ts does this).
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(FAQ_QUERY, { variables: { first: MAX_FAQS } });
    const result = (await response.json()) as {
      data?: {
        metaobjects?: {
          nodes?: Array<{ fields: Array<{ key: string; value: string | null }> }>;
          pageInfo?: { hasNextPage?: boolean };
        };
      };
    };

    const nodes = result.data?.metaobjects?.nodes ?? [];
    const facts = nodes
      .map((node) => toFaqFact(node.fields))
      .filter((fact): fact is FaqFact => fact !== null);

    if (result.data?.metaobjects?.pageInfo?.hasNextPage) {
      console.warn(
        `[faq-facts] more than ${MAX_FAQS} FAQ entries exist — omitting the rest rather than growing the prompt unbounded`,
      );
    }

    cached = { facts, expiresAt: now + CACHE_TTL_MS };
    return facts;
  } catch (error) {
    console.warn(
      `[faq-facts] falling back to no FAQ grounding: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}
