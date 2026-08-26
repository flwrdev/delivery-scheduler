import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

import prisma from "../db.server";
import {
  DELIVERY_SYNC_LEASE_MS,
  processDeliverySyncTask,
} from "../services/delivery-sync-task.server";
import {
  enqueueDeliverySyncTask,
  resolveOpsWorkerSecret,
} from "../services/messenger-queue.server";

// Hourly rescue sweep for stranded DeliverySyncTask rows (ADR-22, Phase A) —
// belt-and-suspenders behind the Cloud Tasks retry chain, same posture as
// internal.lalamove-poll.ts (Cloud Scheduler job, shared-secret header). A row
// is stranded when it is still pending, due per its own nextAttemptAt pacing,
// and no live worker holds its lease (Cloud Tasks retries exhausted, a task
// that never got enqueued, or a crashed worker whose lease went stale).
// Re-enqueueing a row a live worker DOES hold is harmless: the new task's
// claim sees "locked" and no-ops.

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

  if (stranded.length === 0) {
    return Response.json({ ok: true, checked: 0, enqueued: 0, inline: 0, errored: 0 });
  }

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

  return Response.json({ ok: true, checked: stranded.length, enqueued, inline, errored });
};
