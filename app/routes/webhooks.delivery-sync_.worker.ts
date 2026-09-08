import type { ActionFunctionArgs } from "react-router";

import { verifyHmacSha256Signature } from "../lib/verify-hmac-signature.server";
import { processDeliverySyncTask } from "../services/delivery-sync-task.server";
import {
  OPS_WORKER_SIGNATURE_HEADER,
  resolveOpsWorkerSecret,
} from "../services/ops-queue.server";

// Cloud Tasks worker for the orders/create delivery sync (ADR-22, Phase A).
// Mirrors webhooks.support-chat_.worker.ts exactly — same signature scheme,
// same status contract with Cloud Tasks (it retries on any non-2xx):
//   200 — done, or retrying can never help (terminal row, unknown task,
//         another worker holds the lease, permanent failure)
//   503 — transient failure; retry with backoff
//
// Auth: HMAC-SHA256 over the raw body (sha256=<hex>) keyed with the ops
// secret (OPS_WORKER_SECRET, falling back to MESSENGER_WORKER_SECRET — the
// enqueue side resolves the secret through the SAME function, so signer and
// verifier can never disagree).
//
// Zero-duplicate guarantee (merchant constraint 2026-08-26): the atomic lease
// claim inside processDeliverySyncTask means a Cloud Tasks redispatch that
// lands while the first attempt still runs sees "locked" and no-ops with a
// 200; a redispatch after success sees a terminal row. See
// delivery-sync-task.server.ts for the full double-processing story.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const rawBody = await request.text();

  const workerSecret = resolveOpsWorkerSecret();
  if (!workerSecret) {
    console.error("[delivery-sync-worker] no worker secret configured");
    return new Response(null, { status: 401 });
  }

  const signature = request.headers.get(OPS_WORKER_SIGNATURE_HEADER);
  if (!verifyHmacSha256Signature(rawBody, signature, workerSecret)) {
    console.warn("[delivery-sync-worker] rejected task with missing/invalid signature");
    return new Response(null, { status: 401 });
  }

  let taskId: string | undefined;
  try {
    const payload = JSON.parse(rawBody) as { deliverySyncTaskId?: unknown };
    taskId =
      typeof payload.deliverySyncTaskId === "string"
        ? payload.deliverySyncTaskId
        : undefined;
  } catch {
    console.error("[delivery-sync-worker] malformed JSON payload on a validly signed task");
    return new Response(null, { status: 200 });
  }

  if (!taskId) {
    console.error("[delivery-sync-worker] task payload has no deliverySyncTaskId");
    return new Response(null, { status: 200 });
  }

  try {
    const result = await processDeliverySyncTask(taskId);
    switch (result.status) {
      case "done":
        console.log(`[delivery-sync-worker] done task=${taskId}`);
        return new Response(null, { status: 200 });
      case "retry":
        console.warn(`[delivery-sync-worker] transient failure task=${taskId}: ${result.error}`);
        return new Response(null, { status: 503 });
      case "failed":
        // Permanent (attempts cap or no offline session) — surfaced on the
        // ops-page banner; Cloud Tasks must stop.
        console.warn(`[delivery-sync-worker] failed terminally task=${taskId}: ${result.error}`);
        return new Response(null, { status: 200 });
      case "locked":
        console.log(`[delivery-sync-worker] skipped task=${taskId} (another worker holds the lease)`);
        return new Response(null, { status: 200 });
      case "terminal":
      case "not_found":
      default:
        console.log(`[delivery-sync-worker] nothing to do task=${taskId} (${result.status})`);
        return new Response(null, { status: 200 });
    }
  } catch (error) {
    console.warn(
      `[delivery-sync-worker] processing threw task=${taskId}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return new Response(null, { status: 503 });
  }
};
