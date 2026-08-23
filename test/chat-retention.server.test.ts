// Chat-data retention purge (2026-08-24). Same prisma-stub idiom as
// test/agent-rate-limit.server.test.ts — never touches a real DB.
//
// Also carries the read-only guard this repo uses for side-channel routes
// (see test/occasion-reminders.test.ts): the purge must never grow a Shopify
// Admin API dependency.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    supportChatJob: { deleteMany: vi.fn() },
    supportChatMessage: { deleteMany: vi.fn() },
    supportChatThread: { findMany: vi.fn(), deleteMany: vi.fn() },
    agentRateLimit: { deleteMany: vi.fn() },
    lookupAttempt: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import { RETENTION, runChatRetentionPurge } from "../app/services/chat-retention.server";

const NOW = new Date("2026-08-24T21:00:00Z");

function expectedCutoff(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.supportChatJob.deleteMany.mockResolvedValue({ count: 3 });
  prismaMock.supportChatMessage.deleteMany.mockResolvedValue({ count: 5 });
  prismaMock.supportChatThread.findMany.mockResolvedValue([]);
  prismaMock.supportChatThread.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.agentRateLimit.deleteMany.mockResolvedValue({ count: 7 });
  prismaMock.lookupAttempt.deleteMany.mockResolvedValue({ count: 2 });
  // The real $transaction receives the (already-started) prisma promises and
  // awaits them; the stub just resolves whatever it was handed.
  prismaMock.$transaction.mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
});

describe("runChatRetentionPurge", () => {
  it("deletes stale jobs at the 7-day cutoff regardless of channel or status", async () => {
    await runChatRetentionPurge(NOW);

    expect(prismaMock.supportChatJob.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff(RETENTION.jobsDays) } },
    });
  });

  it("ages out customer-account MESSAGES at 90 days but never their thread rows", async () => {
    await runChatRetentionPurge(NOW);

    expect(prismaMock.supportChatMessage.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: expectedCutoff(RETENTION.customerAccountMessageDays) },
        thread: { channel: "customer-account" },
      },
    });
    // No storefront threads were stale, so no thread delete of any kind ran.
    expect(prismaMock.supportChatThread.deleteMany).not.toHaveBeenCalled();
  });

  it("whole-thread-deletes idle storefront threads: children first, cutoff re-asserted on the thread row", async () => {
    prismaMock.supportChatThread.findMany.mockResolvedValue([
      { id: "storefront:aaa" },
      { id: "storefront:bbb" },
    ]);
    prismaMock.supportChatMessage.deleteMany
      .mockResolvedValueOnce({ count: 5 }) // customer-account pass
      .mockResolvedValueOnce({ count: 11 }); // storefront pass
    prismaMock.supportChatJob.deleteMany
      .mockResolvedValueOnce({ count: 3 }) // global stale-jobs pass
      .mockResolvedValueOnce({ count: 4 }); // storefront pass
    prismaMock.supportChatThread.deleteMany.mockResolvedValue({ count: 2 });

    const summary = await runChatRetentionPurge(NOW);

    const idleCutoff = expectedCutoff(RETENTION.storefrontThreadIdleDays);
    expect(prismaMock.supportChatThread.findMany).toHaveBeenCalledWith({
      where: { channel: "storefront", updatedAt: { lt: idleCutoff } },
      select: { id: true },
      take: 500,
    });
    const ids = ["storefront:aaa", "storefront:bbb"];
    expect(prismaMock.supportChatMessage.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ids } },
    });
    expect(prismaMock.supportChatJob.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ids } },
    });
    expect(prismaMock.supportChatThread.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ids }, updatedAt: { lt: idleCutoff } },
    });
    expect(summary).toMatchObject({
      ok: true,
      storefrontThreadsDeleted: 2,
      storefrontMessagesDeleted: 11,
      storefrontJobsDeleted: 4,
    });
  });

  it("sweeps stale AgentRateLimit and LookupAttempt rows and reports every count", async () => {
    const summary = await runChatRetentionPurge(NOW);

    expect(prismaMock.agentRateLimit.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: expectedCutoff(RETENTION.rateLimitStaleDays) } },
    });
    expect(prismaMock.lookupAttempt.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: expectedCutoff(RETENTION.lookupAttemptStaleDays) } },
    });
    expect(summary).toEqual({
      ok: true,
      jobsDeleted: 3,
      storefrontThreadsDeleted: 0,
      storefrontMessagesDeleted: 0,
      storefrontJobsDeleted: 0,
      customerAccountMessagesDeleted: 5,
      rateLimitRowsDeleted: 7,
      lookupAttemptsDeleted: 2,
    });
  });
});

describe("read-only guard (grep, same idiom as the reminder-scan guard)", () => {
  it("the purge service and route never touch Shopify or the Messenger tables", () => {
    for (const relative of [
      ["app", "services", "chat-retention.server.ts"],
      ["app", "routes", "internal.chat-retention.ts"],
    ] as const) {
      const source = readFileSync(join(__dirname, "..", ...relative), "utf8");
      // Import statements only — prose in comments may NAME shopify.server.
      expect(source).not.toMatch(/from\s+["'][^"']*shopify\.server/);
      expect(source).not.toMatch(/import\(["'][^"']*shopify\.server/);
      expect(source).not.toMatch(/admin\.graphql/i);
      expect(source).not.toMatch(/messengerThread\./);
      expect(source).not.toMatch(/messengerMessage\./);
    }
  });
});
