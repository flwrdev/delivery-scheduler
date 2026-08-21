import type { ActionFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { CUSTOMER_ACCOUNT_CAPABILITIES, runAgentTurn } from "../services/agent-core.server";
import type { AgentChannel } from "../services/agent-core.server";
import { MESSENGER_WORKER_SIGNATURE_HEADER } from "../services/messenger-queue.server";
import {
  completeSupportChatJob,
  failSupportChatJob,
  getSupportChatJob,
  loadSupportChatHistory,
} from "../services/support-chat.server";

// Cloud Tasks worker for the support chat backend (agent-core phase 2).
// Mirrors webhooks.messenger_.worker.ts exactly — same signature scheme, same
// status contract with Cloud Tasks (it retries on any non-2xx):
//   200 — done, or retrying can never help (unknown job, already processed,
//         malformed payload, LLM not configured)
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
// ORDER-COMMITMENT GUARD (below): ordering is Messenger-only in v1
// (CUSTOMER_ACCOUNT_CAPABILITIES.ordering === false), and the deterministic
// CONFIRM_ORDER_ interception lives in the Messenger adapter alone. The
// extension no longer renders a Confirm button at all, but a commitment payload
// can still arrive here as ordinary typed/forged text — and ordinary text goes
// straight to the LLM. So we short-circuit it BEFORE the model ever sees it:
// walang LLM call, walang tools, isang malinaw na sagot lang.

// Matches "CONFIRM_ORDER_<key>" / "EDIT_ORDER" with or without the Messenger
// [TAP] prefix, case-insensitively.
const ORDER_COMMITMENT_PATTERN = /^\s*(?:\[TAP\]\s*)?(?:CONFIRM_ORDER_|EDIT_ORDER)/i;

const ORDERING_UNAVAILABLE_TEXT = [
  "Pasensya na po — hindi pa pwedeng mag-place o mag-edit ng order dito sa chat na ito. 🌸",
  "",
  "Pwede po kayong mag-order sa https://flowercart.store, o kausapin kami sa Messenger page namin kung gusto niyo ng tulong habang pumipili.",
  "",
  "Dito naman, kaya ko pa rin sagutin ang mga tanong niyo tungkol sa bouquets, delivery dates, delivery fees, at status ng order niyo.",
].join("\n");

/**
 * The newest customer turn in the loaded history — that is the message this job
 * was minted for (the POST route records it before enqueueing).
 */
function latestCustomerText(messages: Array<{ role: string; content: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    if (!Array.isArray(message.content)) {
      return "";
    }
    return message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          (block as { type?: unknown })?.type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

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
    const messages = await loadSupportChatHistory(threadId);

    // Defence in depth — an order-commitment payload never reaches the LLM.
    if (ORDER_COMMITMENT_PATTERN.test(latestCustomerText(messages))) {
      console.warn(
        `[support-chat-worker] order-commitment payload blocked jobId=${jobId} thread=${threadId}`,
      );
      await completeSupportChatJob(jobId, threadId, [
        { type: "text", text: ORDERING_UNAVAILABLE_TEXT },
      ]);
      return new Response(null, { status: 200 });
    }

    const channel: AgentChannel = {
      kind: "customer-account",
      identity: { type: "customer", customerGid: threadId },
      supports: CUSTOMER_ACCOUNT_CAPABILITIES,
      threadId,
    };
    const result = await runAgentTurn({ channel, messages });

    if (result.ok) {
      await completeSupportChatJob(jobId, threadId, result.reply.blocks);
      console.log(`[support-chat-worker] done jobId=${jobId} thread=${threadId}`);
      return new Response(null, { status: 200 });
    }

    if (result.notConfigured) {
      console.error(`[support-chat-worker] LLM not configured — failing jobId=${jobId}`);
      await failSupportChatJob(jobId, result.error);
      return new Response(null, { status: 200 });
    }

    console.warn(`[support-chat-worker] transient failure jobId=${jobId}: ${result.error}`);
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
