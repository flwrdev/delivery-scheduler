import type { ActionFunctionArgs } from "react-router";

import { verifyHmacSha256Signature } from "../lib/verify-hmac-signature.server";
import { processBulkActionJobChunk } from "../services/bulk-action-jobs.server";
import {
  OPS_WORKER_SIGNATURE_HEADER,
  enqueueBulkActionTask,
  resolveOpsWorkerSecret,
} from "../services/ops-queue.server";

// Cloud Tasks worker for /app/orders bulk-action jobs (ADR-22 Phase B).
// Same signature scheme and status contract as the delivery-sync worker:
//   200 — chunk handled (job may be done, or the next chunk's task is
//         enqueued), or retrying can never help (terminal/unknown/locked)
//   503 — transient failure (chunk threw, or the self-re-enqueue failed);
//         Cloud Tasks retries with backoff and the chain resumes
//
// COOPERATIVE CHUNKING: one task processes up to BULK_JOB_CHUNK_SIZE items,
// checkpoints each, then re-enqueues ITSELF (same jobId) and answers 200 —
// every HTTP request stays small, which is the entire point of Phase B (S4).
// A crash mid-chunk is safe: the job lease + per-item claims mean the retry
// resumes from the items still pending, and the executor's per-op idempotency
// covers the one item that may have been mid-flight.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const rawBody = await request.text();

  const workerSecret = resolveOpsWorkerSecret();
  if (!workerSecret) {
    console.error("[bulk-action-worker] no worker secret configured");
    return new Response(null, { status: 401 });
  }

  const signature = request.headers.get(OPS_WORKER_SIGNATURE_HEADER);
  if (!verifyHmacSha256Signature(rawBody, signature, workerSecret)) {
    console.warn("[bulk-action-worker] rejected task with missing/invalid signature");
    return new Response(null, { status: 401 });
  }

  let jobId: string | undefined;
  try {
    const payload = JSON.parse(rawBody) as { bulkActionJobId?: unknown };
    jobId =
      typeof payload.bulkActionJobId === "string"
        ? payload.bulkActionJobId
        : undefined;
  } catch {
    console.error("[bulk-action-worker] malformed JSON payload on a validly signed task");
    return new Response(null, { status: 200 });
  }

  if (!jobId) {
    console.error("[bulk-action-worker] task payload has no bulkActionJobId");
    return new Response(null, { status: 200 });
  }

  try {
    const result = await processBulkActionJobChunk(jobId);
    switch (result.status) {
      case "done":
        console.log(`[bulk-action-worker] job done job=${jobId}`);
        return new Response(null, { status: 200 });
      case "continue": {
        const enq = await enqueueBulkActionTask({ jobId });
        if (!enq.ok) {
          // Chain break — 503 so Cloud Tasks retries THIS task; the claim
          // sees the fresh lease and no-ops until it goes stale, then resumes.
          console.warn(
            `[bulk-action-worker] re-enqueue failed job=${jobId} (${enq.error}); retrying via task backoff`,
          );
          return new Response(null, { status: 503 });
        }
        console.log(
          `[bulk-action-worker] chunk done job=${jobId}, ${result.remaining} remaining — next task enqueued`,
        );
        return new Response(null, { status: 200 });
      }
      case "failed":
        console.warn(`[bulk-action-worker] job failed terminally job=${jobId}: ${result.error}`);
        return new Response(null, { status: 200 });
      case "locked":
        console.log(`[bulk-action-worker] skipped job=${jobId} (another worker holds the lease)`);
        return new Response(null, { status: 200 });
      case "terminal":
      case "not_found":
      default:
        console.log(`[bulk-action-worker] nothing to do job=${jobId} (${result.status})`);
        return new Response(null, { status: 200 });
    }
  } catch (error) {
    console.warn(
      `[bulk-action-worker] processing threw job=${jobId}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return new Response(null, { status: 503 });
  }
};
