// The COD numbers the Messenger agent states in prose (the fee and the order
// cap). Two things matter here and both are customer-visible:
//
//   1. the numbers track /app/cod-settings, so raising the fee to ₱85 stops the
//      bot from promising ₱70;
//   2. NOTHING about a failed lookup changes what the bot says — it falls back
//      to the values the prompt hardcoded before this module existed.
//
// shopify.server is mocked because the real one builds Prisma session storage
// at module load, which cannot initialize inside vitest.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const graphqlMock = vi.fn();

vi.mock("../app/shopify.server", () => ({
  unauthenticated: {
    admin: async () => ({ admin: { graphql: graphqlMock } }),
  },
}));

import {
  COD_FACTS_FALLBACK,
  loadCodFacts,
  resetCodFactsCache,
} from "../app/services/cod-facts.server";

const ORIGINAL_SHOP = process.env.MESSENGER_SHOP;

/** One paymentCustomizations page, shaped like the Admin API's reply. */
function respondWith(
  nodes: Array<{ title: string; jsonValue?: Record<string, unknown> }>,
) {
  graphqlMock.mockResolvedValue({
    json: async () => ({
      data: {
        paymentCustomizations: {
          nodes: nodes.map(({ title, jsonValue }) => ({
            title,
            metafield: jsonValue ? { jsonValue } : null,
          })),
        },
      },
    }),
  });
}

beforeEach(() => {
  resetCodFactsCache();
  graphqlMock.mockReset();
  process.env.MESSENGER_SHOP = "hsrwva-nr.myshopify.com";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_SHOP === undefined) delete process.env.MESSENGER_SHOP;
  else process.env.MESSENGER_SHOP = ORIGINAL_SHOP;
});

describe("COD_FACTS_FALLBACK", () => {
  // The exact numbers the system prompt stated literally until 2026-08-14.
  // Changing them silently changes what customers are told.
  it("is the ₱70 fee and ₱2,500 cap the prompt used to hardcode", () => {
    expect(COD_FACTS_FALLBACK).toEqual({ feeAmount: 70, maximumAmount: 2500 });
  });
});

describe("loadCodFacts", () => {
  it("reads the fee and cap the settings page saved", async () => {
    respondWith([
      { title: "COD eligibility", jsonValue: { feeAmount: 85, maximumAmount: 3000 } },
    ]);

    await expect(loadCodFacts()).resolves.toEqual({
      feeAmount: 85,
      maximumAmount: 3000,
    });
  });

  // A merchant who cleared the cap means "no maximum" — say nothing about a
  // limit rather than repeating a stale one.
  it("treats a blank saved cap as no cap", async () => {
    respondWith([{ title: "COD", jsonValue: { feeAmount: 85, maximumAmount: null } }]);

    await expect(loadCodFacts()).resolves.toEqual({
      feeAmount: 85,
      maximumAmount: null,
    });
  });

  // An ABSENT key is different: the page has never written one, so keep the
  // fallback instead of telling customers COD has no limit at all.
  it("keeps the fallback cap when the key was never written", async () => {
    respondWith([{ title: "COD", jsonValue: { feeAmount: 85 } }]);

    await expect(loadCodFacts()).resolves.toEqual({
      feeAmount: 85,
      maximumAmount: 2500,
    });
  });

  it("falls back on a zero, negative or non-numeric fee", async () => {
    for (const feeAmount of [0, -5, "abc", null]) {
      resetCodFactsCache();
      respondWith([{ title: "COD", jsonValue: { feeAmount, maximumAmount: 3000 } }]);

      await expect(loadCodFacts()).resolves.toEqual({
        feeAmount: 70,
        maximumAmount: 3000,
      });
    }
  });

  // Same pick order as the settings page: the node carrying a config wins over
  // one merely titled "COD", so a second customization cannot shadow it.
  it("prefers the customization that actually carries a config", async () => {
    respondWith([
      { title: "Cash on Delivery rules" },
      { title: "Something else", jsonValue: { feeAmount: 85 } },
    ]);

    await expect(loadCodFacts()).resolves.toMatchObject({ feeAmount: 85 });
  });

  it("falls back when no customization has a config", async () => {
    respondWith([{ title: "Unrelated" }]);

    await expect(loadCodFacts()).resolves.toEqual(COD_FACTS_FALLBACK);
  });

  it("falls back when MESSENGER_SHOP is not configured", async () => {
    delete process.env.MESSENGER_SHOP;

    await expect(loadCodFacts()).resolves.toEqual(COD_FACTS_FALLBACK);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  // A Shopify outage or an expired offline session must not break the chat.
  it("falls back and warns when the lookup throws", async () => {
    graphqlMock.mockRejectedValue(new Error("502 Bad Gateway"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(loadCodFacts()).resolves.toEqual(COD_FACTS_FALLBACK);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[cod-facts]"));
  });

  describe("caching", () => {
    // The prompt this feeds is Anthropic's cached prefix and is rebuilt on
    // every inbound message — one Admin call per message would be pure waste.
    it("serves a hit from memo without calling Shopify again", async () => {
      respondWith([{ title: "COD", jsonValue: { feeAmount: 85 } }]);

      await loadCodFacts(1_000);
      await loadCodFacts(1_000 + 4 * 60 * 1000);

      expect(graphqlMock).toHaveBeenCalledTimes(1);
    });

    it("refetches once the 5-minute window closes", async () => {
      respondWith([{ title: "COD", jsonValue: { feeAmount: 85 } }]);
      await loadCodFacts(1_000);

      respondWith([{ title: "COD", jsonValue: { feeAmount: 90 } }]);
      await expect(loadCodFacts(1_000 + 5 * 60 * 1000 + 1)).resolves.toMatchObject(
        { feeAmount: 90 },
      );
      expect(graphqlMock).toHaveBeenCalledTimes(2);
    });

    // A failure must NOT be memoized — one bad minute would otherwise pin the
    // agent to the fallback for as long as the container lives.
    it("does not cache a fallback result", async () => {
      graphqlMock.mockRejectedValue(new Error("502 Bad Gateway"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadCodFacts(1_000);
      await loadCodFacts(1_000);

      expect(graphqlMock).toHaveBeenCalledTimes(2);
    });
  });
});
