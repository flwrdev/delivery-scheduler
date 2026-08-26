import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-22 Phase B: the /app/orders action's inline-vs-job split. At or under
// BULK_INLINE_MAX the action executes synchronously and answers results
// (exactly the pre-Phase-B contract); above it, the action creates a
// BulkActionJob, enqueues the worker, and answers { mode: "job", jobId } —
// falling back to an un-awaited in-process run when no queue is configured.

const { createJobMock, runToCompletionMock, enqueueBulkMock, executeMock } = vi.hoisted(() => ({
  createJobMock: vi.fn(),
  runToCompletionMock: vi.fn(),
  enqueueBulkMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      admin: { graphql: vi.fn() },
      session: { shop: "test-shop.myshopify.com" },
    }),
  },
}));

vi.mock("../app/services/bulk-action-jobs.server", () => ({
  createBulkActionJob: createJobMock,
  runBulkJobToCompletion: runToCompletionMock,
}));

vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueBulkActionTask: enqueueBulkMock,
  enqueueDeliverySyncTask: vi.fn(),
}));

vi.mock("../app/services/bulk-actions.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/bulk-actions.server")>();
  return { ...actual, executeBulkAction: executeMock };
});

import { action, type BulkActionResponse } from "../app/routes/app.orders";
import { BULK_INLINE_MAX } from "../app/services/bulk-actions.server";

function archiveRequest(count: number): Request {
  const fd = new FormData();
  fd.set("_action", "archive");
  for (let i = 0; i < count; i++) {
    fd.append("orderId", `gid://shopify/Order/${1000 + i}`);
  }
  return new Request("https://app.example.com/app/orders", {
    method: "POST",
    body: fd,
  });
}

async function callAction(request: Request): Promise<{ status: number; body: BulkActionResponse }> {
  const response = await action({ request } as never);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  createJobMock.mockResolvedValue({ jobId: "job-1" });
  runToCompletionMock.mockResolvedValue(undefined);
  enqueueBulkMock.mockResolvedValue({ ok: true, taskName: "t" });
  executeMock.mockImplementation(async (_admin, _shop, _params, ids: string[]) =>
    ids.map((orderId) => ({ orderId, success: true })),
  );
});

describe("/app/orders action — inline vs job split", () => {
  it(`runs ≤ ${BULK_INLINE_MAX} orders inline through the shared executor`, async () => {
    const { status, body } = await callAction(archiveRequest(BULK_INLINE_MAX));
    expect(status).toBe(200);
    expect(body.mode).toBeUndefined();
    expect(body.summary).toEqual({ ok: BULK_INLINE_MAX, failed: 0 });
    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      "test-shop.myshopify.com",
      { op: "archive" },
      expect.arrayContaining(["gid://shopify/Order/1000"]),
    );
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it(`turns > ${BULK_INLINE_MAX} orders into a job + enqueue and answers mode:"job"`, async () => {
    const { status, body } = await callAction(archiveRequest(BULK_INLINE_MAX + 1));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      action: "archive",
      mode: "job",
      jobId: "job-1",
      total: BULK_INLINE_MAX + 1,
    });
    expect(createJobMock).toHaveBeenCalledWith(
      "test-shop.myshopify.com",
      { op: "archive" },
      expect.any(Array),
    );
    expect(enqueueBulkMock).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(executeMock).not.toHaveBeenCalled();
    expect(runToCompletionMock).not.toHaveBeenCalled();
  });

  it("falls back to an un-awaited in-process run when no queue is configured", async () => {
    enqueueBulkMock.mockResolvedValue({ ok: false, error: "nc", notConfigured: true });
    const { body } = await callAction(archiveRequest(BULK_INLINE_MAX + 5));
    expect(body.mode).toBe("job");
    expect(runToCompletionMock).toHaveBeenCalledWith("job-1");
  });

  it("still validates params BEFORE creating a job (bad tags never become a job)", async () => {
    const fd = new FormData();
    fd.set("_action", "tagsAdd");
    fd.set("tags", "   ");
    for (let i = 0; i < BULK_INLINE_MAX + 5; i++) {
      fd.append("orderId", `gid://shopify/Order/${2000 + i}`);
    }
    const { status } = await callAction(
      new Request("https://app.example.com/app/orders", { method: "POST", body: fd }),
    );
    expect(status).toBe(400);
    expect(createJobMock).not.toHaveBeenCalled();
  });
});
