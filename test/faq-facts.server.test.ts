// The merchant's own Knowledge Base FAQ entries, baked into the agent's
// system prompt. Two things matter here and both are customer-visible:
//
//   1. an entry the merchant edits in the Knowledge Base app should reach
//      the agent within the cache window, without a redeploy;
//   2. NOTHING about a failed lookup should break a turn — it degrades to
//      no FAQ section at all, exactly like the prompt behaved before this
//      module existed.
//
// shopify.server is mocked because the real one builds Prisma session
// storage at module load, which cannot initialize inside vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const graphqlMock = vi.fn();

vi.mock("../app/shopify.server", () => ({
  unauthenticated: {
    admin: async () => ({ admin: { graphql: graphqlMock } }),
  },
}));

import { loadFaqFacts, resetFaqFactsCache } from "../app/services/faq-facts.server";

const ORIGINAL_SHOP = process.env.MESSENGER_SHOP;

/** One metaobjects page, shaped like the Admin API's reply. */
function respondWith(
  nodes: Array<Array<{ key: string; value: string | null }>>,
  hasNextPage = false,
) {
  graphqlMock.mockResolvedValue({
    json: async () => ({
      data: {
        metaobjects: {
          nodes: nodes.map((fields) => ({ fields })),
          pageInfo: { hasNextPage },
        },
      },
    }),
  });
}

beforeEach(() => {
  resetFaqFactsCache();
  graphqlMock.mockReset();
  process.env.MESSENGER_SHOP = "hsrwva-nr.myshopify.com";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_SHOP === undefined) delete process.env.MESSENGER_SHOP;
  else process.env.MESSENGER_SHOP = ORIGINAL_SHOP;
});

describe("loadFaqFacts", () => {
  it("maps question/answer fields into FaqFact pairs", async () => {
    respondWith([
      [
        { key: "question", value: "Do you deliver in Metro Manila?" },
        { key: "answer", value: "Yes, and nearby provinces too." },
        { key: "sources", value: null },
      ],
      [
        { key: "question", value: "What is the delivery fee?" },
        { key: "answer", value: "It varies by address." },
        { key: "sources", value: null },
      ],
    ]);

    await expect(loadFaqFacts()).resolves.toEqual([
      { question: "Do you deliver in Metro Manila?", answer: "Yes, and nearby provinces too." },
      { question: "What is the delivery fee?", answer: "It varies by address." },
    ]);
  });

  it("skips a node missing question or answer instead of crashing", async () => {
    respondWith([
      [{ key: "question", value: "No answer here" }],
      [{ key: "answer", value: "No question here" }],
      [
        { key: "question", value: "Complete pair" },
        { key: "answer", value: "Kept." },
      ],
    ]);

    await expect(loadFaqFacts()).resolves.toEqual([{ question: "Complete pair", answer: "Kept." }]);
  });

  it("returns an empty list when the store has no FAQ entries", async () => {
    respondWith([]);

    await expect(loadFaqFacts()).resolves.toEqual([]);
  });

  it("warns but does not throw when more than MAX_FAQS entries exist", async () => {
    respondWith([[{ key: "question", value: "Q" }, { key: "answer", value: "A" }]], true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await loadFaqFacts();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[faq-facts]"));
  });

  it("falls back to an empty list when MESSENGER_SHOP is not configured", async () => {
    delete process.env.MESSENGER_SHOP;

    await expect(loadFaqFacts()).resolves.toEqual([]);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  // A Shopify outage or an expired offline session must not break the chat —
  // the prompt just renders without the FAQ section, same as before this
  // module existed.
  it("falls back to an empty list and warns when the lookup throws", async () => {
    graphqlMock.mockRejectedValue(new Error("502 Bad Gateway"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(loadFaqFacts()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[faq-facts]"));
  });

  describe("caching", () => {
    // The prompt this feeds is Anthropic's cached prefix and is rebuilt on
    // every inbound message — one Admin call per message would be pure waste.
    it("serves a hit from memo without calling Shopify again", async () => {
      respondWith([[{ key: "question", value: "Q" }, { key: "answer", value: "A" }]]);

      await loadFaqFacts(1_000);
      await loadFaqFacts(1_000 + 4 * 60 * 1000);

      expect(graphqlMock).toHaveBeenCalledTimes(1);
    });

    it("refetches once the 5-minute window closes", async () => {
      respondWith([[{ key: "question", value: "Q1" }, { key: "answer", value: "A1" }]]);
      await loadFaqFacts(1_000);

      respondWith([[{ key: "question", value: "Q2" }, { key: "answer", value: "A2" }]]);
      await expect(loadFaqFacts(1_000 + 5 * 60 * 1000 + 1)).resolves.toEqual([
        { question: "Q2", answer: "A2" },
      ]);
      expect(graphqlMock).toHaveBeenCalledTimes(2);
    });

    // A failure must NOT be memoized — one bad minute would otherwise pin the
    // agent to "no FAQ section" for as long as the container lives.
    it("does not cache a fallback result", async () => {
      graphqlMock.mockRejectedValue(new Error("502 Bad Gateway"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadFaqFacts(1_000);
      await loadFaqFacts(1_000);

      expect(graphqlMock).toHaveBeenCalledTimes(2);
    });
  });
});
