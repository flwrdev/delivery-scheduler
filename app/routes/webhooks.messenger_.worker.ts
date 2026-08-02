import type { ActionFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { processAgentTurnByMid, processOrderFollowUp } from "../services/messenger-agent.server";
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
  let followUp: { psid?: unknown; orderKey?: unknown } | undefined;
  try {
    const payload = JSON.parse(rawBody) as {
      mid?: unknown;
      followUp?: { psid?: unknown; orderKey?: unknown };
    };
    mid = payload.mid as string | undefined;
    followUp = payload.followUp;
  } catch {
    console.error("[messenger-worker] malformed JSON payload on a validly signed task");
    return new Response(null, { status: 200 });
  }

  // Abandoned-order follow-up task (2026-08-03): delayed reminder — ang
  // processOrderFollowUp guards ang nagpapasya kung sesend pa (mark-before-send,
  // kaya ang retry pagkatapos ng claim ay laging skipped).
  if (followUp && typeof followUp.psid === "string" && typeof followUp.orderKey === "string") {
    try {
      const result = await processOrderFollowUp(followUp.psid, followUp.orderKey);
      if (result.status === "retryable_failure") {
        console.warn(`[messenger-worker] follow-up transient psid=${followUp.psid}: ${result.error}`);
        return new Response(null, { status: 503 });
      }
      console.log(`[messenger-worker] follow-up psid=${followUp.psid} status=${result.status}`);
      return new Response(null, { status: 200 });
    } catch (error) {
      console.warn(
        `[messenger-worker] follow-up threw psid=${followUp.psid}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      return new Response(null, { status: 503 });
    }
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
