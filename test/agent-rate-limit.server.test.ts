// Turn-volume rate limiting for the storefront chat widget (2026-08-22).
// Same mocking idiom as test/order-lookup.server.test.ts's LookupAttempt
// tests: stub prisma, never touch a real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    agentRateLimit: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import { checkAndRecordAgentRateLimit } from "../app/services/agent-rate-limit.server";

const KEY = "conv:11111111-1111-4111-8111-111111111111";
const LIMIT = 20;
const WINDOW_MS = 60 * 60_000;

beforeEach(() => {
  prismaMock.agentRateLimit.findUnique.mockReset();
  prismaMock.agentRateLimit.upsert.mockReset();
  prismaMock.agentRateLimit.upsert.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("checkAndRecordAgentRateLimit", () => {
  it("allows and creates a fresh row for a first-ever call", async () => {
    prismaMock.agentRateLimit.findUnique.mockResolvedValueOnce(null);
    const now = new Date("2026-08-22T10:00:00Z");

    const result = await checkAndRecordAgentRateLimit(KEY, LIMIT, WINDOW_MS, now);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const upsertArgs = prismaMock.agentRateLimit.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArgs.where).toEqual({ key: KEY });
    expect(upsertArgs.create).toEqual({ key: KEY, windowStart: now, count: 1 });
    expect(upsertArgs.update).toEqual({ windowStart: now, count: 1 });
  });

  it("accumulates count across calls within the same window", async () => {
    const windowStart = new Date("2026-08-22T10:00:00Z");
    prismaMock.agentRateLimit.findUnique.mockResolvedValueOnce({ windowStart, count: 5 });
    const now = new Date("2026-08-22T10:05:00Z");

    const result = await checkAndRecordAgentRateLimit(KEY, LIMIT, WINDOW_MS, now);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const upsertArgs = prismaMock.agentRateLimit.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArgs.update).toEqual({ windowStart, count: 6 });
  });

  it("blocks once the count exceeds the limit, with a retryAfterSeconds until window end", async () => {
    const windowStart = new Date("2026-08-22T10:00:00Z");
    prismaMock.agentRateLimit.findUnique.mockResolvedValueOnce({ windowStart, count: LIMIT });
    const now = new Date("2026-08-22T10:10:00Z"); // 10 min into a 60 min window

    const result = await checkAndRecordAgentRateLimit(KEY, LIMIT, WINDOW_MS, now);

    expect(result.allowed).toBe(false);
    // 50 minutes left in the window.
    expect(result.retryAfterSeconds).toBe(50 * 60);
    const upsertArgs = prismaMock.agentRateLimit.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArgs.update.count).toBe(LIMIT + 1);
  });

  it("resets to a fresh window once the old window has fully expired, even if it was at the limit", async () => {
    const staleWindowStart = new Date("2026-08-22T08:00:00Z");
    prismaMock.agentRateLimit.findUnique.mockResolvedValueOnce({
      windowStart: staleWindowStart,
      count: LIMIT,
    });
    const now = new Date("2026-08-22T10:00:00Z"); // 2h later, window is 1h

    const result = await checkAndRecordAgentRateLimit(KEY, LIMIT, WINDOW_MS, now);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const upsertArgs = prismaMock.agentRateLimit.upsert.mock.calls.at(-1)?.[0];
    expect(upsertArgs.update).toEqual({ windowStart: now, count: 1 });
  });

  it("keeps two independent keys from cross-contaminating (separate findUnique calls)", async () => {
    prismaMock.agentRateLimit.findUnique.mockResolvedValue(null);
    const now = new Date("2026-08-22T10:00:00Z");

    await checkAndRecordAgentRateLimit("conv:aaa", LIMIT, WINDOW_MS, now);
    await checkAndRecordAgentRateLimit("conv:bbb", LIMIT, WINDOW_MS, now);

    expect(prismaMock.agentRateLimit.findUnique).toHaveBeenNthCalledWith(1, {
      where: { key: "conv:aaa" },
      select: { windowStart: true, count: true },
    });
    expect(prismaMock.agentRateLimit.findUnique).toHaveBeenNthCalledWith(2, {
      where: { key: "conv:bbb" },
      select: { windowStart: true, count: true },
    });
  });

  it("fails open (allowed:true) when prisma throws — availability over a stricter guard on a transient DB error", async () => {
    prismaMock.agentRateLimit.findUnique.mockRejectedValueOnce(new Error("db down"));

    const result = await checkAndRecordAgentRateLimit(KEY, LIMIT, WINDOW_MS);

    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
