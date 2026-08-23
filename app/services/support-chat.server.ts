// Support chat backend (customer-account extension, agent-core phase 2).
//
// WHY enqueue-then-poll: customer account UI extensions run in a sandboxed
// Web Worker with no documented SSE support and a buffered fetch, and an
// agent turn takes 3-15s. Cloud Run also throttles CPU once a response
// returns (the same reason the Messenger path uses Cloud Tasks). So the POST
// route records the turn, mints a jobId, enqueues a task, and answers in
// under a second; the extension polls GET .../api/support-chat/<jobId> until
// status flips to "done".
//
// Neon holds the CONVERSATION + JOB STATUS only — never the order (order
// state lives on the Shopify order, per architecture.md). Same posture as
// MessengerThread/MessengerMessage.
//
// Log hygiene: threadId (customerGid), jobId, statuses, counts, tool names,
// error strings — NEVER message text or LLM output.

import crypto from "node:crypto";

import type { AgentBlock } from "./agent-channel";
import type { LlmContentBlock, LlmMessage } from "./messenger-llm.server";
import prisma from "../db.server";

// Conversation context window (rows) pulled from Neon per turn — same cap the
// Messenger loop uses.
const HISTORY_LIMIT = 20;

export interface EnsureThreadInput {
  customerGid: string;
  shop: string;
}

// One row per signed-in customer (id = customerGid) — upsert is idempotent
// across every turn from the same customer.
export async function ensureSupportChatThread({
  customerGid,
  shop,
}: EnsureThreadInput): Promise<void> {
  await prisma.supportChatThread.upsert({
    where: { id: customerGid },
    create: { id: customerGid, shop, customerGid, channel: "customer-account" },
    update: { shop },
  });
}

export interface EnsureAnonymousThreadInput {
  conversationId: string;
  shop: string;
}

// One row per storefront-widget conversation (id = "storefront:<uuid>",
// customerGid null — there is no signed-in identity on this channel). The
// "storefront:" prefix is cheap defense-in-depth namespacing against the id
// space ever colliding with a customerGid, even though gid://shopify/... and
// a client-minted UUID can't actually collide.
export async function ensureAnonymousSupportChatThread({
  conversationId,
  shop,
}: EnsureAnonymousThreadInput): Promise<string> {
  const id = `storefront:${conversationId}`;
  await prisma.supportChatThread.upsert({
    where: { id },
    create: { id, shop, customerGid: null, channel: "storefront" },
    update: { shop },
  });
  return id;
}

export interface SupportChatThreadChannel {
  channel: string;
  customerGid: string | null;
}

// Read once at the top of runSupportChatTurn to reconstruct the right
// AgentChannel per job, instead of threading a channel argument through
// every caller (worker, inline dev fallbacks) — see support-chat-turn.server.ts.
export async function getSupportChatThreadChannel(
  threadId: string,
): Promise<SupportChatThreadChannel | null> {
  return prisma.supportChatThread.findUnique({
    where: { id: threadId },
    select: { channel: true, customerGid: true },
  });
}

export async function recordCustomerTurn(threadId: string, text: string): Promise<void> {
  await prisma.supportChatMessage.create({
    data: { threadId, role: "customer", bodyJson: JSON.stringify({ text }) },
  });
}

export interface CreateJobResult {
  jobId: string;
}

// jobId is minted BEFORE enqueue (mirrors the Messenger conversationOrderKey
// idempotency posture) so the row exists the instant the extension starts
// polling, even if the enqueue call itself is still in flight.
export async function createSupportChatJob(threadId: string): Promise<CreateJobResult> {
  const jobId = crypto.randomUUID();
  await prisma.supportChatJob.create({
    data: { id: jobId, threadId, status: "pending" },
  });
  return { jobId };
}

export interface SupportChatJobRow {
  id: string;
  threadId: string;
  status: string;
  blocksJson: string | null;
  error: string | null;
}

export async function getSupportChatJob(jobId: string): Promise<SupportChatJobRow | null> {
  return prisma.supportChatJob.findUnique({
    where: { id: jobId },
    select: { id: true, threadId: true, status: true, blocksJson: true, error: true },
  });
}

// Chronological history -> LlmMessage[]. Assistant rows store the neutral
// AgentBlock[] the agent-core loop produced; only the "text" blocks feed back
// into the LLM's own transcript (products/slots/choices are UI affordances,
// not something the model needs to re-read as its own prior words).
export async function loadSupportChatHistory(threadId: string): Promise<LlmMessage[]> {
  const rows = await prisma.supportChatMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, bodyJson: true },
  });
  rows.reverse();

  const messages: LlmMessage[] = [];
  for (const row of rows) {
    let text = "";
    try {
      const parsed = JSON.parse(row.bodyJson) as { text?: unknown; blocks?: unknown };
      if (typeof parsed.text === "string") {
        text = parsed.text;
      } else if (Array.isArray(parsed.blocks)) {
        text = (parsed.blocks as AgentBlock[])
          .filter((block): block is Extract<AgentBlock, { type: "text" }> => block?.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
      }
    } catch {
      // Malformed row — skip it from history rather than poison the turn.
      continue;
    }
    if (!text) {
      continue;
    }
    const content: LlmContentBlock[] = [{ type: "text", text }];
    messages.push({ role: row.role === "customer" ? "user" : "assistant", content });
  }
  return messages;
}

// Mark-before-send analog for a queue worker: write the finished blocks +
// status "done" AND append the assistant row in one place, so a retry that
// finds status !== "pending" is a guaranteed no-op (see the worker route).
export async function completeSupportChatJob(
  jobId: string,
  threadId: string,
  blocks: AgentBlock[],
): Promise<void> {
  await prisma.$transaction([
    prisma.supportChatJob.update({
      where: { id: jobId },
      data: { status: "done", blocksJson: JSON.stringify(blocks), error: null },
    }),
    prisma.supportChatMessage.create({
      data: { threadId, role: "assistant", bodyJson: JSON.stringify({ blocks }) },
    }),
  ]);
}

// Close a job that can never produce a reply — the history handed to the LLM
// did not end on a customer turn (interleaved turns / a retry after the
// assistant row already landed). Status "done" with ZERO blocks so the polling
// extension stops immediately and renders nothing, and deliberately NO assistant
// message row: the turn never happened, kaya wala dapat itong iiwan sa history.
export async function skipSupportChatJob(jobId: string): Promise<void> {
  await prisma.supportChatJob.update({
    where: { id: jobId },
    data: { status: "done", blocksJson: "[]", error: null },
  });
}

export async function failSupportChatJob(jobId: string, error: string): Promise<void> {
  await prisma.supportChatJob.update({
    where: { id: jobId },
    data: { status: "failed", error },
  });
}
