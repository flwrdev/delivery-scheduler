import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-22 Phase B: the bulk-job orchestration's load-bearing behaviors — the
// ATOMIC JOB CLAIM, the per-item pending→processing claim, chunk checkpointing
// with counters recomputed from the item table, stale-processing rescue, and
// the terminal paths. executeBulkAction itself is mocked (its behavior is
// pinned by its own tests + the route tests).

const {
  jobCreateMock,
  jobUpdateManyMock,
  jobUpdateMock,
  jobFindUniqueMock,
  itemUpdateManyMock,
  itemUpdateMock,
  itemFindManyMock,
  itemCountMock,
  adminMock,
  executeMock,
} = vi.hoisted(() => ({
  jobCreateMock: vi.fn(),
  jobUpdateManyMock: vi.fn(),
  jobUpdateMock: vi.fn(),
  jobFindUniqueMock: vi.fn(),
  itemUpdateManyMock: vi.fn(),
  itemUpdateMock: vi.fn(),
  itemFindManyMock: vi.fn(),
  itemCountMock: vi.fn(),
  adminMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    bulkActionJob: {
      create: jobCreateMock,
      updateMany: jobUpdateManyMock,
      update: jobUpdateMock,
      findUnique: jobFindUniqueMock,
    },
    bulkActionJobItem: {
      updateMany: itemUpdateManyMock,
      update: itemUpdateMock,
      findMany: itemFindManyMock,
      count: itemCountMock,
    },
  },
}));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

vi.mock("../app/services/bulk-actions.server", () => ({
  executeBulkAction: executeMock,
}));

import {
  BULK_JOB_LEASE_MS,
  claimBulkActionJob,
  createBulkActionJob,
  getBulkActionJobStatus,
  processBulkActionJobChunk,
  runBulkJobToCompletion,
} from "../app/services/bulk-action-jobs.server";

const SHOP = "flowercart-dev.myshopify.com";

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    shop: SHOP,
    action: "archive",
    paramsJson: JSON.stringify({ op: "archive" }),
    status: "queued",
    lockedAt: null,
    totalCount: 30,
    okCount: 0,
    failCount: 0,
    lastError: null,
    createdAt: new Date(0),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobCreateMock.mockResolvedValue({ id: "job-1" });
  jobUpdateManyMock.mockResolvedValue({ count: 1 });
  jobUpdateMock.mockResolvedValue({});
  itemUpdateManyMock.mockResolvedValue({ count: 0 });
  itemUpdateMock.mockResolvedValue({});
  itemFindManyMock.mockResolvedValue([]);
  itemCountMock.mockResolvedValue(0);
  adminMock.mockResolvedValue({ admin: { graphql: vi.fn() } });
  executeMock.mockResolvedValue([]);
});

describe("createBulkActionJob", () => {
  it("snapshots the validated params and creates one item per order", async () => {
    const ids = ["gid://shopify/Order/1", "gid://shopify/Order/2"];
    const { jobId } = await createBulkActionJob(SHOP, { op: "archive" }, ids);
    expect(jobId).toBe("job-1");
    const args = jobCreateMock.mock.calls[0][0];
    expect(args.data).toMatchObject({
      shop: SHOP,
      action: "archive",
      paramsJson: JSON.stringify({ op: "archive" }),
      totalCount: 2,
    });
    expect(args.data.items.create).toEqual(
      ids.map((id) => ({ shopifyOrderId: id })),
    );
  });
});

describe("claimBulkActionJob — the atomic claim", () => {
  it("check and take are ONE conditional update over queued/running + stale lease", async () => {
    const now = new Date("2026-08-27T10:00:00Z");
    expect(await claimBulkActionJob("job-1", now)).toBe(true);
    const args = jobUpdateManyMock.mock.calls[0][0];
    expect(args.where).toEqual({
      id: "job-1",
      status: { in: ["queued", "running"] },
      OR: [
        { lockedAt: null },
        { lockedAt: { lt: new Date(now.getTime() - BULK_JOB_LEASE_MS) } },
      ],
    });
    expect(args.data).toEqual({ lockedAt: now, status: "running" });
  });

  it("count 0 means another worker won", async () => {
    jobUpdateManyMock.mockResolvedValue({ count: 0 });
    expect(await claimBulkActionJob("job-1")).toBe(false);
  });
});

describe("processBulkActionJobChunk", () => {
  it("returns not_found / terminal / locked without executing", async () => {
    jobFindUniqueMock.mockResolvedValue(null);
    expect(await processBulkActionJobChunk("nope")).toEqual({ status: "not_found" });

    jobFindUniqueMock.mockResolvedValue(baseJob({ status: "done" }));
    expect(await processBulkActionJobChunk("job-1")).toEqual({ status: "terminal" });

    jobFindUniqueMock.mockResolvedValue(baseJob());
    jobUpdateManyMock.mockResolvedValue({ count: 0 });
    expect(await processBulkActionJobChunk("job-1")).toEqual({ status: "locked" });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("processes a chunk: stale reset, item claim, execute, checkpoint, renew lease, continue", async () => {
    jobFindUniqueMock.mockResolvedValue(baseJob());
    itemFindManyMock.mockResolvedValue([
      { id: "i1", shopifyOrderId: "gid://shopify/Order/1" },
      { id: "i2", shopifyOrderId: "gid://shopify/Order/2" },
    ]);
    executeMock.mockResolvedValue([
      { orderId: "gid://shopify/Order/1", success: true },
      { orderId: "gid://shopify/Order/2", success: false, message: "boom" },
    ]);
    // ok, failed, remaining
    itemCountMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(13);

    const result = await processBulkActionJobChunk("job-1");
    expect(result).toEqual({ status: "continue", remaining: 13 });

    // Stale-processing rescue ran before the claim.
    expect(itemUpdateManyMock).toHaveBeenCalledWith({
      where: {
        jobId: "job-1",
        status: "processing",
        updatedAt: { lt: expect.any(Date) },
      },
      data: { status: "pending" },
    });
    // Items claimed pending → processing before execution.
    expect(itemUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["i1", "i2"] }, status: "pending" },
      data: { status: "processing" },
    });
    // Executor got exactly the chunk's order ids with the snapshotted params.
    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      { op: "archive" },
      ["gid://shopify/Order/1", "gid://shopify/Order/2"],
    );
    // Per-item checkpoints.
    expect(itemUpdateMock).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { status: "ok", message: null },
    });
    expect(itemUpdateMock).toHaveBeenCalledWith({
      where: { id: "i2" },
      data: { status: "failed", message: "boom" },
    });
    // Counters recomputed + lease renewed (job stays running).
    const lastJobUpdate = jobUpdateMock.mock.calls.at(-1)![0];
    expect(lastJobUpdate.data).toMatchObject({ okCount: 1, failCount: 1 });
    expect(lastJobUpdate.data.lockedAt).toBeInstanceOf(Date);
  });

  it("finishes the job when nothing is pending or processing", async () => {
    jobFindUniqueMock.mockResolvedValue(baseJob({ status: "running", startedAt: new Date() }));
    itemFindManyMock.mockResolvedValue([]);
    itemCountMock
      .mockResolvedValueOnce(28)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const result = await processBulkActionJobChunk("job-1");
    expect(result).toEqual({ status: "done" });
    const lastJobUpdate = jobUpdateMock.mock.calls.at(-1)![0];
    expect(lastJobUpdate.data).toMatchObject({
      status: "done",
      okCount: 28,
      failCount: 2,
      lockedAt: null,
    });
    expect(lastJobUpdate.data.finishedAt).toBeInstanceOf(Date);
  });

  it("no offline session fails the job terminally", async () => {
    jobFindUniqueMock.mockResolvedValue(baseJob());
    adminMock.mockRejectedValue(new Error("no session"));
    const result = await processBulkActionJobChunk("job-1");
    expect(result.status).toBe("failed");
    expect(jobUpdateMock).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({ status: "failed", lockedAt: null }),
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("releases the lease when an unexpected throw escapes", async () => {
    jobFindUniqueMock.mockResolvedValue(baseJob());
    itemFindManyMock.mockRejectedValue(new Error("connection lost"));
    await expect(processBulkActionJobChunk("job-1")).rejects.toThrow("connection lost");
    expect(jobUpdateManyMock).toHaveBeenLastCalledWith({
      where: { id: "job-1" },
      data: { lockedAt: null },
    });
  });
});

describe("runBulkJobToCompletion", () => {
  it("loops chunks until the job is no longer continuing", async () => {
    jobFindUniqueMock.mockResolvedValue(baseJob({ status: "running" }));
    itemFindManyMock
      .mockResolvedValueOnce([{ id: "i1", shopifyOrderId: "gid://shopify/Order/1" }])
      .mockResolvedValueOnce([]);
    executeMock.mockResolvedValue([{ orderId: "gid://shopify/Order/1", success: true }]);
    itemCountMock
      // chunk 1: ok, failed, remaining
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      // chunk 2: ok, failed, remaining
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await runBulkJobToCompletion("job-1");
    expect(executeMock).toHaveBeenCalledTimes(1);
    const lastJobUpdate = jobUpdateMock.mock.calls.at(-1)![0];
    expect(lastJobUpdate.data).toMatchObject({ status: "done" });
  });
});

describe("getBulkActionJobStatus", () => {
  it("answers found:false for a missing job AND for another shop's job (anti-enumeration)", async () => {
    jobFindUniqueMock.mockResolvedValue(null);
    expect(await getBulkActionJobStatus(SHOP, "nope")).toEqual({ found: false });

    jobFindUniqueMock.mockResolvedValue(baseJob({ shop: "other.myshopify.com" }));
    expect(await getBulkActionJobStatus(SHOP, "job-1")).toEqual({ found: false });
  });

  it("reports progress without results while running, full results when done", async () => {
    jobFindUniqueMock.mockResolvedValue(
      baseJob({ status: "running", okCount: 10, failCount: 1 }),
    );
    const running = await getBulkActionJobStatus(SHOP, "job-1");
    expect(running).toMatchObject({
      found: true,
      status: "running",
      okCount: 10,
      failCount: 1,
      totalCount: 30,
    });
    expect(running.results).toBeUndefined();

    jobFindUniqueMock.mockResolvedValue(baseJob({ status: "done", okCount: 29, failCount: 1 }));
    itemFindManyMock.mockResolvedValue([
      { shopifyOrderId: "gid://shopify/Order/1", status: "ok", message: null },
      { shopifyOrderId: "gid://shopify/Order/2", status: "failed", message: "boom" },
    ]);
    const done = await getBulkActionJobStatus(SHOP, "job-1");
    expect(done.results).toEqual([
      { orderId: "gid://shopify/Order/1", success: true, message: undefined },
      { orderId: "gid://shopify/Order/2", success: false, message: "boom" },
    ]);
  });
});
