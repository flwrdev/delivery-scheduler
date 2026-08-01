import type { ActionFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { processAgentTurnByMid } from "../services/messenger-agent.server";
import { MESSENGER_WORKER_SIGNATURE_HEADER } from "../services/messenger-queue.server";

// Cloud Tasks worker for the FlowerCart Messenger agent (phase 3).
//
// POST /webhooks/messenger/worker — invoked ONLY by Cloud Tasks with a payload
// the webhook enqueued. Auth: HMAC-SHA256 over the raw body (same sha256=<hex>
// format as Meta's webhook signature, same verifier lib) keyed with
// MESSENGER_WORKER_SECRET.
//
// Status contract with Cloud Tasks (it retries on any non-2xx):
//   200 — done, or retrying can never help (unknown mid, already replied,
//         malformed payload, sending not configured)
//   503 — transient send failure; retry with backoff
//
// Zero-duplicate guarantee: processAgentTurnByMid skips any message whose
// repliedAt is already set, so a retry after a successful send is a no-op.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const rawBody = await request.text();

  const workerSecret = process.env.MESSENGER_WORKER_SECRET?.trim();
  if (!workerSecret) {
    console.error("[messenger-worker] MESSENGER_WORKER_SECRET not configured");
    return new Response(null, { status: 401 });
  }

  const signature = request.headers.get(MESSENGER_WORKER_SIGNATURE_HEADER);
  if (!verifyMetaWebhookSignature(rawBody, signature, workerSecret)) {
    console.warn("[messenger-worker] rejected task with missing/invalid signature");
    return new Response(null, { status: 401 });
  }

  let mid: string | undefined;
  try {
    mid = (JSON.parse(rawBody) as { mid?: unknown }).mid as string | undefined;
  } catch {
    console.error("[messenger-worker] malformed JSON payload on a validly signed task");
    return new Response(null, { status: 200 });
  }
  if (typeof mid !== "string" || !mid) {
    console.error("[messenger-worker] task payload has no mid");
    return new Response(null, { status: 200 });
  }

  try {
    const result = await processAgentTurnByMid(mid);
    switch (result.status) {
      case "sent":
        console.log(`[messenger-worker] replied mid=${mid} reply=${result.replyMid}`);
        return new Response(null, { status: 200 });
      case "skipped":
        console.log(`[messenger-worker] skipped mid=${mid} (already replied or not a customer message)`);
        return new Response(null, { status: 200 });
      case "not_found":
        console.warn(`[messenger-worker] no recorded message for mid=${mid}`);
        return new Response(null, { status: 200 });
      case "not_configured":
        console.error("[messenger-worker] sending not configured — dropping task");
        return new Response(null, { status: 200 });
      case "retryable_failure":
        console.warn(`[messenger-worker] send failed for mid=${mid}: ${result.error}`);
        return new Response(null, { status: 503 });
    }
  } catch (error) {
    console.warn(
      `[messenger-worker] processing threw for mid=${mid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return new Response(null, { status: 503 });
  }
};
