// Bulk-action job orchestration (ADR-22 Phase B, docs/proposals/orders-async-jobs.md §3b).
//
// A /app/orders bulk op on more than BULK_INLINE_MAX orders becomes one
// BulkActionJob + per-order BulkActionJobItem rows. The Cloud Tasks worker
// (webhooks.bulk-action_.worker.ts) calls processBulkActionJobChunk repeatedly
// — each call handles up to CHUNK_SIZE items, checkpoints every item, renews
// the job lease, and the worker re-enqueues itself until nothing is left. Every
// HTTP request stays small (the root cause S4 fixed).
//
// Double-processing guards (merchant constraint §2a), three layers:
// 1. Job lease — claimBulkActionJob is ONE conditional updateMany (status
//    queued/running + lockedAt null-or-stale → lockedAt=now); the losing
//    worker sees count 0 and walks away. Renewed every chunk.
// 2. Item claim — items move pending → processing before execution; a crashed
//    worker's stuck "processing" items are reset to pending only after the
//    lease window, by the lease holder.
// 3. The executor's per-op idempotency (see bulk-actions.server.ts) makes even
//    a pathological re-execution write only identical values.
//
// The actual order writes happen in executeBulkAction — the SAME function the
// inline path calls, so the two paths cannot drift.

import prisma from "../db.server";
import {
  executeBulkAction,
  type BulkActionItemResult,
  type BulkActionName,
  type BulkOpParams,
} from "./bulk-actions.server";
import { unauthenticated } from "../shopify.server";

export const BULK_JOB_LEASE_MS = 5 * 60 * 1000;
export const BULK_JOB_CHUNK_SIZE = 15;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createBulkActionJob(
  shop: string,
  params: BulkOpParams,
  orderIds: string[],
): Promise<{ jobId: string }> {
  const job = await prisma.bulkActionJob.create({
    data: {
      shop,
      action: params.op,
      paramsJson: JSON.stringify(params),
      totalCount: orderIds.length,
      items: {
        create: orderIds.map((id) => ({ shopifyOrderId: id })),
      },
    },
  });
  return { jobId: job.id };
}

// §2a atomic claim — same shape as claimDeliverySyncTask.
export async function claimBulkActionJob(
  jobId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - BULK_JOB_LEASE_MS);
  const claimed = await prisma.bulkActionJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["queued", "running"] },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    data: { lockedAt: now, status: "running" },
  });
  return claimed.count === 1;
}

export type ProcessBulkChunkResult =
  | { status: "done" }
  | { status: "continue"; remaining: number }
  | { status: "terminal" } // job already done/failed
  | { status: "not_found" }
  | { status: "locked" } // another worker holds the lease
  | { status: "failed"; error: string }; // permanent — job marked failed

export async function processBulkActionJobChunk(
  jobId: string,
): Promise<ProcessBulkChunkResult> {
  const job = await prisma.bulkActionJob.findUnique({ where: { id: jobId } });
  if (!job) return { status: "not_found" };
  if (job.status === "done" || job.status === "failed") {
    return { status: "terminal" };
  }
  const now = new Date();
  if (!(await claimBulkActionJob(jobId, now))) return { status: "locked" };

  try {
    if (!job.startedAt) {
      await prisma.bulkActionJob.update({
        where: { id: jobId },
        data: { startedAt: now },
      });
    }

    // A prior worker that crashed mid-chunk leaves items stuck "processing";
    // only the lease holder resets them, and only once they are stale.
    const staleBefore = new Date(now.getTime() - BULK_JOB_LEASE_MS);
    await prisma.bulkActionJobItem.updateMany({
      where: { jobId, status: "processing", updatedAt: { lt: staleBefore } },
      data: { status: "pending" },
    });

    let admin;
    try {
      ({ admin } = await unauthenticated.admin(job.shop));
    } catch (error) {
      // No offline session is not transient — fail the job terminally.
      const message = `no offline session for ${job.shop}: ${errorMessage(error)}`;
      console.warn(`[bulk-jobs] ${jobId}: ${message}`);
      await prisma.bulkActionJob.update({
        where: { id: jobId },
        data: { status: "failed", lastError: message, lockedAt: null },
      });
      return { status: "failed", error: message };
    }

    // Claim a chunk of items (pending → processing). The job lease means no
    // other worker is inside this job right now, so the found set is ours.
    const chunk = await prisma.bulkActionJobItem.findMany({
      where: { jobId, status: "pending" },
      orderBy: { id: "asc" },
      take: BULK_JOB_CHUNK_SIZE,
      select: { id: true, shopifyOrderId: true },
    });

    if (chunk.length > 0) {
      const chunkItemIds = chunk.map((c: { id: string }) => c.id);
      await prisma.bulkActionJobItem.updateMany({
        where: { id: { in: chunkItemIds }, status: "pending" },
        data: { status: "processing" },
      });

      const params = JSON.parse(job.paramsJson) as BulkOpParams;
      const orderIds = chunk.map((c: { shopifyOrderId: string }) => c.shopifyOrderId);
      const results = await executeBulkAction(admin, job.shop, params, orderIds);

      const resultByOrderId = new Map<string, BulkActionItemResult>(
        results.map((r) => [r.orderId, r]),
      );
      for (const item of chunk) {
        const r = resultByOrderId.get(item.shopifyOrderId);
        await prisma.bulkActionJobItem.update({
          where: { id: item.id },
          data: {
            status: r?.success ? "ok" : "failed",
            message: r?.message ?? (r ? null : "No result reported."),
          },
        });
      }
    }

    // Recompute counters from the item table (never drift-prone increments).
    const [okCount, failCount, remaining] = await Promise.all([
      prisma.bulkActionJobItem.count({ where: { jobId, status: "ok" } }),
      prisma.bulkActionJobItem.count({ where: { jobId, status: "failed" } }),
      prisma.bulkActionJobItem.count({
        where: { jobId, status: { in: ["pending", "processing"] } },
      }),
    ]);

    if (remaining === 0) {
      await prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: "done",
          okCount,
          failCount,
          finishedAt: new Date(),
          lockedAt: null,
        },
      });
      console.log(`[bulk-jobs] ${jobId}: done (${okCount} ok, ${failCount} failed).`);
      return { status: "done" };
    }

    await prisma.bulkActionJob.update({
      where: { id: jobId },
      data: { okCount, failCount, lockedAt: new Date() }, // renew the lease
    });
    return { status: "continue", remaining };
  } catch (error) {
    // Unexpected throw: release the lease so the retry isn't stuck behind a
    // 5-minute stale window; stuck "processing" items reset on the next chunk.
    try {
      await prisma.bulkActionJob.updateMany({
        where: { id: jobId },
        data: { lockedAt: null },
      });
    } catch {
      // The lease goes stale on its own.
    }
    throw error;
  }
}

// Dev / enqueue-failure fallback: run the whole job in-process, chunk by
// chunk. NOT awaited by the action (fire-and-forget locally; the sweep is the
// backstop if the process dies).
export async function runBulkJobToCompletion(jobId: string): Promise<void> {
  for (;;) {
    let result: ProcessBulkChunkResult;
    try {
      result = await processBulkActionJobChunk(jobId);
    } catch (error) {
      console.warn(`[bulk-jobs] inline run for ${jobId} threw: ${errorMessage(error)}`);
      return;
    }
    if (result.status !== "continue") return;
  }
}

// ─── Client polling surface (app.orders_.bulk-job.$jobId) ────────────────────

export interface BulkActionJobStatus {
  found: boolean;
  jobId?: string;
  action?: BulkActionName;
  status?: string;
  totalCount?: number;
  okCount?: number;
  failCount?: number;
  lastError?: string | null;
  // Present only once the job is done/failed — same shape the inline path
  // returns, so the client reuses one completion handler.
  results?: BulkActionItemResult[];
}

export async function getBulkActionJobStatus(
  shop: string,
  jobId: string,
): Promise<BulkActionJobStatus> {
  const job = await prisma.bulkActionJob.findUnique({ where: { id: jobId } });
  // Anti-enumeration: a job belonging to another shop answers exactly like a
  // missing one.
  if (!job || job.shop !== shop) return { found: false };

  const base: BulkActionJobStatus = {
    found: true,
    jobId: job.id,
    action: job.action as BulkActionName,
    status: job.status,
    totalCount: job.totalCount,
    okCount: job.okCount,
    failCount: job.failCount,
    lastError: job.lastError,
  };
  if (job.status === "done" || job.status === "failed") {
    const items = await prisma.bulkActionJobItem.findMany({
      where: { jobId: job.id },
      orderBy: { id: "asc" },
      select: { shopifyOrderId: true, status: true, message: true },
    });
    base.results = items.map(
      (i: { shopifyOrderId: string; status: string; message: string | null }) => ({
        orderId: i.shopifyOrderId,
        success: i.status === "ok",
        message: i.message ?? undefined,
      }),
    );
  }
  return base;
}
