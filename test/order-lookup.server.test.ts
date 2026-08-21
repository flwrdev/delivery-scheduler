// Order-number+zip lookup (2026-08-21) — replaces email-only verification.
// Same mocking idiom as test/messenger-orders.server.test.ts: stub the admin
// client and prisma, never touch the real DB or Shopify.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, adminMock } = vi.hoisted(() => ({
  prismaMock: {
    lookupAttempt: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  adminMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

import {
  clearLookupFailures,
  isLookupLocked,
  lookupOrderByNameAndZip,
  lookupOrdersByCustomerId,
  normalizeOrderName,
  normalizeZip,
  recordLookupFailure,
} from "../app/services/order-lookup.server";

const graphqlMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function orderNode(overrides: Record<string, unknown> = {}) {
  return {
    name: "#3979",
    createdAt: "2026-08-02T16:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    shippingAddress: { zip: "1300" },
    customAttributes: [
      { key: "Delivery Date", value: "2026-08-03" },
      { key: "Delivery Time", value: "3PM-6PM" },
    ],
    fulfillments: [
      {
        trackingInfo: [
          { number: "TRK123", url: "https://track.example.com/TRK123", company: "Lalamove" },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
  graphqlMock.mockReset();
  adminMock.mockReset();
  adminMock.mockResolvedValue({ admin: { graphql: graphqlMock } });
  prismaMock.lookupAttempt.findUnique.mockReset();
  prismaMock.lookupAttempt.upsert.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeOrderName / normalizeZip", () => {
  it("strips a leading # and trims whitespace", () => {
    expect(normalizeOrderName("#3979")).toBe("3979");
    expect(normalizeOrderName(" 3979 ")).toBe("3979");
    expect(normalizeOrderName("  #3979  ")).toBe("3979");
  });

  it("strips every non-digit from a zip", () => {
    expect(normalizeZip("1300")).toBe("1300");
    expect(normalizeZip("1300 ")).toBe("1300");
    expect(normalizeZip("13 00")).toBe("1300");
    expect(normalizeZip("PH-1300")).toBe("1300");
  });
});

describe("lookupOrderByNameAndZip", () => {
  it("happy path: matching order name + zip returns full tracking info", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual({
      name: "#3979",
      createdAt: "2026-08-02T16:00:00Z",
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      deliveryDate: "2026-08-03",
      deliveryTime: "3PM-6PM",
      trackingUrl: "https://track.example.com/TRK123",
      trackingNumber: "TRK123",
      trackingCompany: "Lalamove",
    });
    expect(result.note).toContain("tracking");
  });

  it("never puts the zip into the GraphQL query variables", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    const vars = (graphqlMock.mock.calls[0][1] as { variables: { query: string } }).variables;
    expect(vars.query).toBe('name:"3979"');
    expect(vars.query).not.toContain("1300");
  });

  it("wrong zip: returns the generic failure, same as a wrong order number", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "9999" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const wrongZipError = result.error;

    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const result2 = await lookupOrderByNameAndZip({ orderName: "#0000", zip: "1300" });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error).toBe(wrongZipError);
  });

  it("wrong order number (no matching node): generic failure", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#0000", zip: "1300" });
    expect(result.ok).toBe(false);
  });

  it("zip formatting variance: '1300', '1300 ', and '13 00' all match", async () => {
    for (const variant of ["1300", "1300 ", "13 00"]) {
      graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
      const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: variant });
      expect(result.ok).toBe(true);
    }
  });

  it("order name with and without '#' both match", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const withHash = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(withHash.ok).toBe(true);

    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const withoutHash = await lookupOrderByNameAndZip({ orderName: "3979", zip: "1300" });
    expect(withoutHash.ok).toBe(true);
  });

  it("missing shippingAddress on the order: generic failure, never throws", async () => {
    graphqlMock.mockResolvedValueOnce(
      jsonResponse({ data: { orders: { nodes: [orderNode({ shippingAddress: null })] } } }),
    );
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
  });

  it("tracking info absent: fields are simply omitted, still ok:true", async () => {
    graphqlMock.mockResolvedValueOnce(
      jsonResponse({ data: { orders: { nodes: [orderNode({ fulfillments: [] })] } } }),
    );
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.trackingUrl).toBeUndefined();
    expect(result.order.trackingNumber).toBeUndefined();
    expect(result.order.trackingCompany).toBeUndefined();
  });

  it("missing input: designed failure without calling Shopify", async () => {
    const result = await lookupOrderByNameAndZip({ orderName: "", zip: "1300" });
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("GraphQL rejection surfaces as a designed failure, never throws", async () => {
    graphqlMock.mockRejectedValueOnce(new Error("boom"));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
  });

  it("queries a 25-node page with sortKey RELEVANCE (MINOR-2 fix)", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(graphqlMock.mock.calls[0][0]).toContain("first: 25");
    expect(graphqlMock.mock.calls[0][0]).toContain("sortKey: RELEVANCE");
  });

  it("MINOR-2: a full page with no exact match is ambiguous, not a real mismatch — not a plain failure", async () => {
    // #100 is a prefix of #1000..#1004 etc — simulate a full 25-node page of
    // loose `name:` matches, none of which is an EXACT match for "100".
    const nodes = Array.from({ length: 25 }, (_, i) => orderNode({ name: `#${1000 + i}` }));
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#100", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBe(true);
  });

  it("a real mismatch (short page, genuinely no matching order) is NOT ambiguous", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#0000", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBeUndefined();
  });

  it("a wrong zip on an exact name match is NOT ambiguous (the order was found, zip is just wrong)", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "9999" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.ambiguous).toBeUndefined();
  });
});

// MAJOR fix: the caller cannot tell a real wrong guess from an outage by
// reading the error string (that indistinguishability is deliberate), so every
// failure carries a machine-readable `reason`. Only "mismatch" is a real guess.
describe("lookupOrderByNameAndZip — failure reason discriminant", () => {
  it("a wrong ZIP on an existing order is reason=mismatch", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "9999" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mismatch");
  });

  it("a wrong ORDER NUMBER (short page) is reason=mismatch", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#0000", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mismatch");
  });

  it("ANTI-ENUMERATION: the mismatch error string is byte-identical for a wrong order number vs a wrong zip", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const wrongZip = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "9999" });

    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const wrongOrderNumber = await lookupOrderByNameAndZip({ orderName: "#0000", zip: "1300" });

    expect(wrongZip.ok).toBe(false);
    expect(wrongOrderNumber.ok).toBe(false);
    if (wrongZip.ok || wrongOrderNumber.ok) return;
    // Same bytes, same reason — the customer (and the LLM) learns nothing about
    // which half was wrong; only the lockout accounting can tell them apart.
    expect(wrongOrderNumber.error).toBe(wrongZip.error);
    expect(wrongOrderNumber.reason).toBe(wrongZip.reason);
  });

  it("a FULL page with no exact match is reason=ambiguous (inconclusive, not a wrong guess)", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => orderNode({ name: `#${1000 + i}` }));
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes } } }));
    const result = await lookupOrderByNameAndZip({ orderName: "#100", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
    expect(result.ambiguous).toBe(true);
  });

  it("a missing field is reason=invalid_input (a prompting issue, not a guess)", async () => {
    const noOrder = await lookupOrderByNameAndZip({ orderName: "", zip: "1300" });
    expect(noOrder.ok).toBe(false);
    if (noOrder.ok) return;
    expect(noOrder.reason).toBe("invalid_input");

    const noZip = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "" });
    expect(noZip.ok).toBe(false);
    if (noZip.ok) return;
    expect(noZip.reason).toBe("invalid_input");
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("MESSENGER_SHOP unset is reason=upstream, never the customer's fault", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream");
  });

  it("an unavailable Admin client is reason=upstream", async () => {
    adminMock.mockRejectedValueOnce(new Error("no offline session"));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream");
  });

  it("a GraphQL errors[] body is reason=upstream", async () => {
    graphqlMock.mockResolvedValueOnce(
      jsonResponse({ errors: [{ message: "Throttled" }] }, 200),
    );
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream");
  });

  it("a thrown GraphQL call is reason=upstream", async () => {
    graphqlMock.mockRejectedValueOnce(new Error("socket hang up"));
    const result = await lookupOrderByNameAndZip({ orderName: "#3979", zip: "1300" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("upstream");
  });
});

describe("lookupOrdersByCustomerId", () => {
  it("happy path: extracts the numeric id and queries by customer_id", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [orderNode()] } } }));
    const result = await lookupOrdersByCustomerId("gid://shopify/Customer/778899");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].name).toBe("#3979");
    const vars = (graphqlMock.mock.calls[0][1] as { variables: { query: string } }).variables;
    expect(vars.query).toBe("customer_id:778899");
  });

  it("rejects a malformed gid without calling Shopify", async () => {
    const result = await lookupOrdersByCustomerId("not-a-gid");
    expect(result.ok).toBe(false);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("REDACTION: never returns an address, a zip, or a phone number", async () => {
    graphqlMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          orders: {
            nodes: [
              orderNode({
                shippingAddress: { zip: "1300", address1: "255 Kawit St", phone: "09624224085" },
              }),
            ],
          },
        },
      }),
    );
    const result = await lookupOrdersByCustomerId("gid://shopify/Customer/778899");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.orders);
    expect(serialized).not.toContain("Kawit");
    expect(serialized).not.toContain("09624224085");
    expect(serialized).not.toContain("1300");
  });

  it("a malformed gid is reason=invalid_input; an upstream failure is reason=upstream", async () => {
    const malformed = await lookupOrdersByCustomerId("not-a-gid");
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.reason).toBe("invalid_input");

    graphqlMock.mockRejectedValueOnce(new Error("socket hang up"));
    const upstream = await lookupOrdersByCustomerId("gid://shopify/Customer/778899");
    expect(upstream.ok).toBe(false);
    if (upstream.ok) return;
    expect(upstream.reason).toBe("upstream");
  });

  it("zero orders: ok:true with an empty list", async () => {
    graphqlMock.mockResolvedValueOnce(jsonResponse({ data: { orders: { nodes: [] } } }));
    const result = await lookupOrdersByCustomerId("gid://shopify/Customer/1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orders).toEqual([]);
  });
});

describe("lockout: recordLookupFailure / clearLookupFailures / isLookupLocked (LookupAttempt)", () => {
  const KEY = "gid://shopify/Customer/778899";

  it("is not locked with no prior failures", async () => {
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: null });
    expect(await isLookupLocked(KEY)).toBe(false);
  });

  it("locks after 5 consecutive failures", async () => {
    // Simulate 5 sequential failures, each reading the prior row then upserting +1.
    let row: { failures: number; lockedAt: Date | null } | null = null;
    prismaMock.lookupAttempt.findUnique.mockImplementation(async () => row);
    prismaMock.lookupAttempt.upsert.mockImplementation(
      async ({ update }: { update: { failures: number; lockedAt: Date | null } }) => {
        row = { failures: update.failures, lockedAt: update.lockedAt };
        return row;
      },
    );

    for (let i = 0; i < 4; i++) {
      await recordLookupFailure(KEY);
    }
    // Not locked yet after 4.
    let lastUpsertArgs = prismaMock.lookupAttempt.upsert.mock.calls.at(-1)?.[0];
    expect(lastUpsertArgs.update.lockedAt).toBeNull();

    await recordLookupFailure(KEY); // 5th failure
    lastUpsertArgs = prismaMock.lookupAttempt.upsert.mock.calls.at(-1)?.[0];
    expect(lastUpsertArgs.update.failures).toBe(5);
    expect(lastUpsertArgs.update.lockedAt).toBeInstanceOf(Date);
    expect(lastUpsertArgs.where).toEqual({ key: KEY });

    // isLookupLocked reflects a recent lockout timestamp.
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: new Date() });
    expect(await isLookupLocked(KEY)).toBe(true);
  });

  it("a stale lockout (past the 30-minute window) is treated as unlocked", async () => {
    const old = new Date(Date.now() - 31 * 60_000);
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ lockedAt: old });
    expect(await isLookupLocked(KEY)).toBe(false);
  });

  it("MINOR-1: a failure after the lockout window expired resets the count instead of re-locking on 1", async () => {
    // Locked from a stale lockout 31 minutes ago, with the failure count
    // still sitting at 5 from before.
    const old = new Date(Date.now() - 31 * 60_000);
    prismaMock.lookupAttempt.findUnique.mockResolvedValueOnce({ failures: 5, lockedAt: old });

    await recordLookupFailure(KEY);

    const upsertArgs = prismaMock.lookupAttempt.upsert.mock.calls.at(-1)?.[0];
    // Fresh allowance: this single new mistake is failure #1, not #6, so it
    // must NOT re-lock the customer.
    expect(upsertArgs.update.failures).toBe(1);
    expect(upsertArgs.update.lockedAt).toBeNull();
  });

  it("clearLookupFailures resets both fields via upsert (works even with no prior row)", async () => {
    await clearLookupFailures(KEY);
    expect(prismaMock.lookupAttempt.upsert).toHaveBeenCalledWith({
      where: { key: KEY },
      create: { key: KEY, failures: 0, lockedAt: null },
      update: { failures: 0, lockedAt: null },
    });
  });

  it("never throws when Prisma fails (fails OPEN, never locks out a real customer on a DB blip)", async () => {
    prismaMock.lookupAttempt.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await isLookupLocked(KEY)).toBe(false);

    prismaMock.lookupAttempt.findUnique.mockRejectedValueOnce(new Error("db down"));
    prismaMock.lookupAttempt.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(recordLookupFailure(KEY)).resolves.toBeUndefined();

    prismaMock.lookupAttempt.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(clearLookupFailures(KEY)).resolves.toBeUndefined();
  });
});
