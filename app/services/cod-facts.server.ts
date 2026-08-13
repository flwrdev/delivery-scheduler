// The two COD numbers the merchant edits on /app/cod-settings, for the
// surfaces that only need to TALK about them: the fee and the order cap.
//
// Everything else that shows the fee reads a copy the settings page writes
// (the `$app:cod`/`fee` shop metafield for the Thank You page, `custom`/
// `cod_fee` for Liquid, `feeAmount` in the function config for the checkout
// label). The Messenger agent is different: it needs the numbers as PROSE
// inside its system prompt, so it reads the same function config the checkout
// function does — one source, no fourth copy to forget.
//
// Cached per process: the system prompt is the byte-identical prefix Anthropic
// caches, so re-deriving it per message would be wasteful, and the values only
// change when a merchant saves the settings page. A stale-by-minutes fee in a
// chat reply is fine; a failed lookup that breaks the conversation is not, so
// every error path falls back to the constants below — which are what the
// prompt hardcoded before this existed.

export type CodFacts = {
  feeAmount: number;
  /** Orders above this cannot use COD. Null = no cap. */
  maximumAmount: number | null;
};

// The values the prompt stated literally until 2026-08-14. Keep them as the
// fallback so an unconfigured shop, a missing session, or a Shopify outage
// leaves the agent saying exactly what it said before.
export const COD_FACTS_FALLBACK: CodFacts = {
  feeAmount: 70,
  maximumAmount: 2500,
};

const CACHE_TTL_MS = 5 * 60 * 1000;

const CONFIG_QUERY = `#graphql
  query CodFactsConfig {
    paymentCustomizations(first: 25) {
      nodes {
        title
        metafield(namespace: "$app:cod-eligibility", key: "function-configuration") {
          jsonValue
        }
      }
    }
  }
`;

let cached: { facts: CodFacts; expiresAt: number } | null = null;

/** Test seam — drops the memo so a suite can exercise a fresh fetch. */
export function resetCodFactsCache(): void {
  cached = null;
}

function toPositiveNumber(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export async function loadCodFacts(now: number = Date.now()): Promise<CodFacts> {
  if (cached && cached.expiresAt > now) {
    return cached.facts;
  }

  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return COD_FACTS_FALLBACK;
  }

  try {
    // Imported lazily: shopify.server builds Prisma session storage at module
    // load, which the Messenger agent's vitest suite cannot initialize — a
    // static import here would drag it into that module graph.
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(CONFIG_QUERY);
    const result = (await response.json()) as {
      data?: {
        paymentCustomizations?: {
          nodes?: Array<{
            title: string;
            metafield?: { jsonValue?: Record<string, unknown> } | null;
          }>;
        };
      };
    };

    const nodes = result.data?.paymentCustomizations?.nodes ?? [];
    // Same pick order as the settings page: the one that actually carries a
    // config, else the one whose title reads like COD.
    const config =
      (
        nodes.find((node) => node.metafield?.jsonValue) ??
        nodes.find((node) => /cod|cash on delivery/i.test(node.title))
      )?.metafield?.jsonValue ?? null;
    if (!config) {
      return COD_FACTS_FALLBACK;
    }

    const facts: CodFacts = {
      feeAmount:
        toPositiveNumber(config.feeAmount) ?? COD_FACTS_FALLBACK.feeAmount,
      // A blank cap is a real setting ("no maximum"), not a missing one — but
      // an ABSENT key means the page has never written one, so keep the
      // fallback rather than telling customers COD has no limit.
      maximumAmount:
        "maximumAmount" in config
          ? toPositiveNumber(config.maximumAmount)
          : COD_FACTS_FALLBACK.maximumAmount,
    };
    cached = { facts, expiresAt: now + CACHE_TTL_MS };
    return facts;
  } catch (error) {
    console.warn(
      `[cod-facts] falling back to defaults: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return COD_FACTS_FALLBACK;
  }
}
