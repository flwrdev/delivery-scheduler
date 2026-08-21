import type { ActionFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { MESSENGER_WORKER_SIGNATURE_HEADER } from "../services/messenger-queue.server";
import { failSupportChatJob, getSupportChatJob } from "../services/support-chat.server";
import { runSupportChatTurn } from "../services/support-chat-turn.server";

// Cloud Tasks worker for the support chat backend (agent-core phase 2).
// Mirrors webhooks.messenger_.worker.ts exactly — same signature scheme, same
// status contract with Cloud Tasks (it retries on any non-2xx):
//   200 — done, or retrying can never help (unknown job, already processed,
//         malformed payload, LLM not configured, malformed history)
//   503 — transient failure; retry with backoff
//
// Auth: HMAC-SHA256 over the raw body (sha256=<hex>) keyed with
// MESSENGER_WORKER_SECRET, verified with the same lib the Meta webhook and
// the Messenger worker use — one shared queue infra, two job kinds.
//
// Zero-duplicate guarantee: a job whose status is no longer "pending" is
// already finished (or already failed unretryably), so a Cloud Tasks retry
// after a successful run is a no-op — same posture as
// MessengerMessage.repliedAt.
//
// Log hygiene: jobId, thread id (customerGid), statuses, tool names, error
// strings — NEVER message text or LLM output.
//
// THE TURN ITSELF LIVES IN support-chat-turn.server.ts — both pre-LLM guards
// (history must end on a customer turn; order-commitment payloads never reach
// the model) and the runAgentTurn call are shared with the inline fallback in
// api.support-chat.tsx, so the two execution paths can't drift apart again.
// This route only owns the Cloud Tasks half: signature, job status, HTTP code.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const rawBody = await request.text();

  const workerSecret = process.env.MESSENGER_WORKER_SECRET?.trim();
  if (!workerSecret) {
    console.error("[support-chat-worker] MESSENGER_WORKER_SECRET not configured");
    return new Response(null, { status: 401 });
  }

  const signature = request.headers.get(MESSENGER_WORKER_SIGNATURE_HEADER);
  if (!verifyMetaWebhookSignature(rawBody, signature, workerSecret)) {
    console.warn("[support-chat-worker] rejected task with missing/invalid signature");
    return new Response(null, { status: 401 });
  }

  let jobId: string | undefined;
  try {
    const payload = JSON.parse(rawBody) as { jobId?: unknown };
    jobId = typeof payload.jobId === "string" ? payload.jobId : undefined;
  } catch {
    console.error("[support-chat-worker] malformed JSON payload on a validly signed task");
    return new Response(null, { status: 200 });
  }

  if (!jobId) {
    console.error("[support-chat-worker] task payload has no jobId");
    return new Response(null, { status: 200 });
  }

  try {
    const job = await getSupportChatJob(jobId);
    if (!job) {
      console.warn(`[support-chat-worker] no recorded job for jobId=${jobId}`);
      return new Response(null, { status: 200 });
    }
    if (job.status !== "pending") {
      console.log(`[support-chat-worker] skipped jobId=${jobId} (already ${job.status})`);
      return new Response(null, { status: 200 });
    }

    const threadId = job.threadId;
    const verdict = await runSupportChatTurn({ jobId, threadId });

    if (verdict.status === "done") {
      console.log(
        `[support-chat-worker] done jobId=${jobId} thread=${threadId} intercepted=${verdict.intercepted}`,
      );
      return new Response(null, { status: 200 });
    }

    if (verdict.status === "skipped") {
      // A malformed transcript is not a transient fault — a retry re-loads the
      // exact same rows. Close it 200 so Cloud Tasks stops.
      console.log(
        `[support-chat-worker] closed jobId=${jobId} thread=${threadId} skip=${verdict.reason}`,
      );
      return new Response(null, { status: 200 });
    }

    if (verdict.notConfigured) {
      console.error(`[support-chat-worker] LLM not configured — failing jobId=${jobId}`);
      await failSupportChatJob(jobId, verdict.error);
      return new Response(null, { status: 200 });
    }

    console.warn(`[support-chat-worker] transient failure jobId=${jobId}: ${verdict.error}`);
    return new Response(null, { status: 503 });
  } catch (error) {
    console.warn(
      `[support-chat-worker] processing threw jobId=${jobId}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return new Response(null, { status: 503 });
  }
};
