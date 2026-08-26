import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

import prisma from "../db.server";
import {
  BULK_JOB_LEASE_MS,
  runBulkJobToCompletion,
} from "../services/bulk-action-jobs.server";
import {
  DELIVERY_SYNC_LEASE_MS,
  processDeliverySyncTask,
} from "../services/delivery-sync-task.server";
import {
  enqueueBulkActionTask,
  enqueueDeliverySyncTask,
  resolveOpsWorkerSecret,
} from "../services/messenger-queue.server";

// Hourly rescue sweep for the ops work queues (ADR-22) — belt-and-suspenders
// behind the Cloud Tasks retry chains, same posture as
// internal.lalamove-poll.ts (Cloud Scheduler job, shared-secret header).
//
// Phase A: a DeliverySyncTask row is stranded when it is still pending, due
// per its own nextAttemptAt pacing, and no live worker holds its lease (Cloud
// Tasks retries exhausted, a task that never got enqueued, or a crashed
// worker whose lease went stale).
//
// Phase B: a BulkActionJob is stranded when it is still queued/running but
// nothing has touched it for a whole lease window (its worker chain died, or
// the dev-fallback process was killed mid-run).
//
// Re-enqueueing work a live worker DOES hold is harmless either way: the new
// task's claim sees "locked" and no-ops.

const MAX_ROWS_PER_RUN = 25;

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const sweepSecret = resolveOpsWorkerSecret();
  const provided = request.headers.get("x-ops-worker-secret")?.trim();
  if (!sweepSecret || !provided || !timingSafeEqualStrings(provided, sweepSecret)) {
    return new Response(null, { status: 401 });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - DELIVERY_SYNC_LEASE_MS);
  const stranded = await prisma.deliverySyncTask.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: MAX_ROWS_PER_RUN,
  });

  let enqueued = 0;
  let inline = 0;
  let errored = 0;
  for (const row of stranded) {
    // One row's failure must never abort the rest of the sweep.
    try {
      const enq = await enqueueDeliverySyncTask({ taskId: row.id });
      if (enq.ok) {
        enqueued++;
      } else if (enq.notConfigured) {
        await processDeliverySyncTask(row.id);
        inline++;
      } else {
        errored++;
        console.warn(`[delivery-sync-sweep] enqueue failed for task ${row.id}: ${enq.error}`);
      }
    } catch (error) {
      errored++;
      console.warn(
        `[delivery-sync-sweep] task ${row.id} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Phase B rescue: stranded bulk jobs — still open, untouched for a whole
  // lease window (updatedAt moves on every chunk checkpoint).
  const bulkStale = new Date(now.getTime() - BULK_JOB_LEASE_MS);
  const strandedJobs = await prisma.bulkActionJob.findMany({
    where: {
      status: { in: ["queued", "running"] },
      updatedAt: { lt: bulkStale },
    },
    orderBy: { updatedAt: "asc" },
    take: MAX_ROWS_PER_RUN,
    select: { id: true },
  });
  let bulkEnqueued = 0;
  let bulkInline = 0;
  for (const job of strandedJobs) {
    try {
      const enq = await enqueueBulkActionTask({ jobId: job.id });
      if (enq.ok) {
        bulkEnqueued++;
      } else if (enq.notConfigured) {
        await runBulkJobToCompletion(job.id);
        bulkInline++;
      } else {
        errored++;
        console.warn(`[delivery-sync-sweep] bulk-job enqueue failed for ${job.id}: ${enq.error}`);
      }
    } catch (error) {
      errored++;
      console.warn(
        `[delivery-sync-sweep] bulk job ${job.id} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return Response.json({
    ok: true,
    checked: stranded.length,
    enqueued,
    inline,
    bulkChecked: strandedJobs.length,
    bulkEnqueued,
    bulkInline,
    errored,
  });
};
