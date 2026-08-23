// ONE execution path for a support-chat agent turn (agent-core phase 2).
//
// WHY THIS FILE EXISTS: the support chat has TWO callers that run the same turn
// — webhooks.support-chat_.worker.ts (the Cloud Tasks path used in prod) and the
// inline fallback inside api.support-chat.tsx (local dev, walang queue). They
// had drifted: only the worker carried the order-commitment interception, so the
// CONFIRM_ORDER_ guard covered one of the two paths. Anything that must be true
// before the LLM sees a customer message now lives HERE, once, kaya hindi na
// pwedeng mag-drift ulit ang dalawang path.
//
// TWO PRE-LLM GUARDS, both mirroring the live Messenger adapter:
//
//  1. HISTORY SHAPE — the conversation must be non-empty AND end on a CUSTOMER
//     turn (messenger-agent.server.ts does the same check before runAgentTurn).
//     If a job is retried after its assistant row was already persisted, or two
//     turns interleave, the history handed to Anthropic ends on an ASSISTANT
//     message — which the API treats as a PREFILL to continue, not a question to
//     answer, and the customer gets a mangled half-sentence continuation of the
//     previous reply. Retrying can never fix that shape, so this is a job we
//     close quietly (status "done", zero blocks, no assistant row) — never a 503.
//
//  2. ORDER COMMITMENT — ordering is Messenger-only in v1
//     (CUSTOMER_ACCOUNT_CAPABILITIES.ordering === false) and the deterministic
//     CONFIRM_ORDER_ tap interception lives in the Messenger adapter alone. The
//     extension no longer renders a Confirm button at all, but a commitment
//     payload can still arrive as ordinary typed/forged text — and ordinary text
//     goes straight to the LLM. So we short-circuit it BEFORE the model ever sees
//     it: walang LLM call, walang tools, isang malinaw na sagot lang.
//
// WHAT THIS FILE DOES NOT DO: it never decides an HTTP status. The worker maps a
// retryable failure to 503 (Cloud Tasks retries); the inline route can't retry at
// all, so it marks the job failed and still answers 200 + ok:true (ADR-11). That
// mapping stays with each caller — only the shared decisions live here.
//
// Log hygiene: jobId, threadId, skip reasons, error strings — NEVER message text
// or LLM output.

import {
  CUSTOMER_ACCOUNT_CAPABILITIES,
  STOREFRONT_CAPABILITIES,
  runAgentTurn,
} from "./agent-core.server";
import type { AgentChannel } from "./agent-core.server";
import type { LlmMessage } from "./messenger-llm.server";
import {
  completeSupportChatJob,
  getSupportChatThreadChannel,
  loadSupportChatHistory,
  skipSupportChatJob,
} from "./support-chat.server";

// Matches "CONFIRM_ORDER_<key>" / "EDIT_ORDER" with or without the Messenger
// [TAP] prefix, case-insensitively.
export const ORDER_COMMITMENT_PATTERN = /^\s*(?:\[TAP\]\s*)?(?:CONFIRM_ORDER_|EDIT_ORDER)/i;

export const ORDERING_UNAVAILABLE_TEXT = [
  "Pasensya na po — hindi pa pwedeng mag-place o mag-edit ng order dito sa chat na ito. 🌸",
  "",
  "Pwede po kayong mag-order sa https://flowercart.store, o kausapin kami sa Messenger page namin kung gusto niyo ng tulong habang pumipili.",
  "",
  "Dito naman, kaya ko pa rin sagutin ang mga tanong niyo tungkol sa bouquets, delivery dates, delivery fees, at status ng order niyo.",
].join("\n");

/** Why a turn was closed without ever calling the LLM. Not retryable, either way. */
export type SupportChatSkipReason = "empty_history" | "trailing_assistant";

export type SupportChatTurnVerdict =
  /** Blocks are already persisted (a real reply, or the ordering short-circuit). */
  | { status: "done"; intercepted: boolean }
  /** Job already closed with zero blocks and no assistant row. */
  | { status: "skipped"; reason: SupportChatSkipReason }
  /** Nothing persisted — the CALLER decides whether its transport can retry. */
  | { status: "failed"; error: string; notConfigured: boolean };

export interface RunSupportChatTurnInput {
  jobId: string;
  threadId: string;
  now?: Date;
}

/**
 * The newest customer turn in the loaded history — that is the message this job
 * was minted for (the POST route records it before enqueueing).
 */
export function latestCustomerText(messages: Array<{ role: string; content: unknown }>): string {
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

/**
 * Guard 1. The LLM turn is only well-formed when the transcript ends on the
 * customer — an assistant tail is read by Anthropic as a prefill to continue.
 */
export function endsOnCustomerTurn(messages: Array<{ role: string }>): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === "user";
}

/** Guard 2. An order-commitment payload must never reach the model as text. */
export function isOrderCommitmentPayload(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  return ORDER_COMMITMENT_PATTERN.test(latestCustomerText(messages));
}

/**
 * Load the history, apply both pre-LLM guards, run the turn, and persist the
 * outcome. Never throws for an upstream failure — every failure comes back as a
 * verdict so the caller can answer 200 (ADR-11) or 503 as its transport demands.
 * A Prisma/loader throw still propagates: both callers already wrap this in the
 * try/catch that owns their transport's retry decision.
 */
export async function runSupportChatTurn({
  jobId,
  threadId,
  now,
}: RunSupportChatTurnInput): Promise<SupportChatTurnVerdict> {
  const messages: LlmMessage[] = await loadSupportChatHistory(threadId);

  if (!endsOnCustomerTurn(messages)) {
    const reason: SupportChatSkipReason =
      messages.length === 0 ? "empty_history" : "trailing_assistant";
    console.warn(
      `[support-chat-turn] skipped jobId=${jobId} thread=${threadId} reason=${reason} turns=${messages.length}`,
    );
    await skipSupportChatJob(jobId);
    return { status: "skipped", reason };
  }

  if (isOrderCommitmentPayload(messages)) {
    console.warn(
      `[support-chat-turn] order-commitment payload blocked jobId=${jobId} thread=${threadId}`,
    );
    await completeSupportChatJob(jobId, threadId, [
      { type: "text", text: ORDERING_UNAVAILABLE_TEXT },
    ]);
    return { status: "done", intercepted: true };
  }

  // Channel is read off the thread row itself rather than threaded through
  // this function's signature — otherwise every caller (worker, both inline
  // dev fallbacks) would independently construct an AgentChannel, tripling
  // the exact drift surface the lockout-key addendum already had to fix once
  // for a similar reason. A job always has a thread by construction, so a
  // miss here means a real bug, not an expected runtime condition.
  const threadChannel = await getSupportChatThreadChannel(threadId);
  if (!threadChannel) {
    console.error(
      `[support-chat-turn] thread not found jobId=${jobId} thread=${threadId}`,
    );
    return { status: "failed", error: "thread not found", notConfigured: false };
  }

  const channel: AgentChannel =
    threadChannel.channel === "storefront"
      ? {
          kind: "storefront",
          identity: {
            type: "anonymous",
            conversationId: threadId.replace(/^storefront:/, ""),
          },
          supports: STOREFRONT_CAPABILITIES,
          threadId,
        }
      : {
          kind: "customer-account",
          identity: { type: "customer", customerGid: threadChannel.customerGid ?? threadId },
          supports: CUSTOMER_ACCOUNT_CAPABILITIES,
          threadId,
        };
  const result = await runAgentTurn(now ? { channel, messages, now } : { channel, messages });

  if (!result.ok) {
    return {
      status: "failed",
      error: result.error,
      notConfigured: result.notConfigured === true,
    };
  }

  await completeSupportChatJob(jobId, threadId, result.reply.blocks);
  return { status: "done", intercepted: false };
}
