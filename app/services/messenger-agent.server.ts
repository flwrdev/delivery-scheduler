// Conversation orchestrator for the FlowerCart Messenger agent (phase 4).
//
// The LLM handles LANGUAGE; this code owns the loop, the tools, the reply
// bookkeeping, and the zero-duplicate guarantee (repliedAt skip — same
// contract the phase-3 echo worker proved live).
//
// Log hygiene: mids, psids, statuses, tool names, error strings — never
// message text or LLM output.

import prisma from "../db.server";
import {
  executeAgentTool,
  getManilaNowLabel,
  MESSENGER_AGENT_TOOLS,
} from "./messenger-agent-tools.server";
import type { GetAvailableDeliverySlotsResult } from "./messenger-agent-tools.server";
import {
  MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
  runLlmTurn,
} from "./messenger-llm.server";
import type { LlmContentBlock, LlmMessage } from "./messenger-llm.server";
import { MESSENGER_NOT_CONFIGURED_MESSAGE, sendMessengerTextMessage } from "./messenger-send.server";

// Messenger rejects text messages longer than 2000 chars.
const MESSENGER_TEXT_LIMIT = 2000;
// Quick replies: max 13 buttons, 20 chars per title (Messenger hard limits).
const QUICK_REPLY_LIMIT = 13;
const QUICK_REPLY_TITLE_LIMIT = 20;
// Conversation context window (rows) pulled from Neon per turn.
const HISTORY_LIMIT = 20;
// Tool-loop ceiling per inbound message.
const MAX_LLM_ITERATIONS = 5;

const BOT_DISCLOSURE =
  "🌸 Ako po si FlowerBot, ang automated assistant ng The Flowercart.";

export type ProcessAgentTurnResult =
  | { status: "sent"; replyMid: string }
  | { status: "skipped" }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "retryable_failure"; error: string };

function buildSystemPrompt(now: Date): string {
  return [
    "You are FlowerBot, the customer service and sales assistant of The Flowercart, a flower shop in the Philippines that delivers within Metro Manila.",
    "",
    "STYLE (merchant-tuned — follow strictly):",
    "- MIRROR the customer's tone of voice: match their formality, their Tagalog-English mix, and their energy. If they text casually, reply casually; if they write in English, lean English.",
    "- Use EVERYDAY words; when a Tagalog word is deep or formal, use the common English word instead (say 'estimate', never 'tantiya').",
    "- FORMAT for easy reading, Messenger-style: short paragraphs with a blank line between thoughts — never one dense block of text. Lists (slots, dates) go on their own lines.",
    "- Answer what was asked; skip facts the customer didn't ask about unless it directly blocks their request.",
    "",
    `Current date and time in Asia/Manila: ${getManilaNowLabel(now)}. All dates are in Asia/Manila.`,
    "",
    "HARD RULES:",
    "- Never state a price, availability, or delivery date that did not come from a tool result in the current turn.",
    "- Never compute a calendar date yourself. When the customer mentions a delivery date in any form, call resolve_date with the phrase structure.",
    "- After resolving a date, always echo it back WITH the weekday (e.g. \"Huwebes, Dec 24\") so the customer can catch a wrong parse.",
    "- Delivery time slots come ONLY from get_available_slots, and only for a resolved date. Never invent or offer a slot that is not in the tool result.",
    "- If the requested date is closed or full, offer the nearest available dates from the tool result.",
    "- You cannot take orders or payments yet. If asked, say the ordering assistant is 'malapit na' and offer to check delivery dates, or hand them to the page for now.",
    "- If you cannot help or the customer asks for a human, tell them a person from The Flowercart will follow up in this thread.",
    "",
    "STORE KNOWLEDGE (merchant-provided facts — you may state these):",
    "- Delivery fee (Lalamove motorcycle + handling): base fare P49 + P6/km for the first 5km + P5/km beyond, plus P40 handling — roughly P90 base. The EXACT fee is computed by Lalamove at checkout.",
    "- FREE SHIPPING on orders P2,500 and up.",
    "- Payment methods: Xendit (cards, bank transfer, QR, e-wallets) or Cash on Delivery. COD has an extra P70 fee added automatically to the total, is available only for orders up to P2,500, and rider booking can take a bit longer on COD. For orders above P2,500 na gusto pa rin ng COD: split payment ang arrangement — the excess is paid online (GCash/Maya) and the rest COD.",
    "- About the shop: The Flowercart is a Metro Manila-based online flower shop — fresh rose bouquets and floral arrangements for all occasions (birthdays, anniversaries, graduations, romantic surprises), with same-day delivery. Website: https://flowercart.store",
    "- Store hours: 9:00 AM to 5:00 PM daily (NOT 24 hours). Store/pickup location: 255 Kawit St, Tondo, Manila. Pickup is welcome — earliest 9:00 AM; ask the customer to say when they plan to drop by so the order is ready.",
    "- Surprise deliveries are welcome: the customer can give rider instructions like 'do not call the recipient' or 'call the sender first'.",
    "- Complete order details (for when they order): bouquet name, recipient name, recipient contact number, delivery address, delivery date and time slot, card message, and any special instructions (optional).",
    "- When check_delivery_coverage returns estimatedFeePhp, quote it as an ESTIMATE only (e.g. 'around P134 po ang estimate') with a short note that the exact fee shows at checkout. Never present the estimate as final, and never compute a fee yourself without the tool.",
    "- Delivery coverage details: https://flowercart.store/pages/delivery-coverage",
    "- When the customer mentions a place or zip code (asking if you deliver there or how much delivery costs), call check_delivery_coverage — coverage and fee-estimate answers come ONLY from that tool, never from your own geography knowledge.",
  ].join("\n");
}

interface StoredMessageRow {
  role: string;
  bodyJson: string;
  mid: string;
}

function historyToLlmMessages(rows: StoredMessageRow[], currentMid: string): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const row of rows) {
    let text = "";
    try {
      text = String((JSON.parse(row.bodyJson) as { text?: unknown }).text ?? "");
    } catch {
      continue;
    }
    if (!text) {
      continue;
    }
    messages.push({
      role: row.role === "bot" ? "assistant" : "user",
      content: [{ type: "text", text }],
    });
    if (row.mid === currentMid) {
      break;
    }
  }
  return messages;
}

function isOpenSlotsResult(value: unknown): value is Extract<
  GetAvailableDeliverySlotsResult,
  { available: true }
> {
  const candidate = value as { ok?: boolean; available?: boolean; slots?: unknown };
  return candidate?.ok === true && candidate.available === true && Array.isArray(candidate.slots);
}

export async function processAgentTurnByMid(mid: string): Promise<ProcessAgentTurnResult> {
  const message = await prisma.messengerMessage.findUnique({ where: { mid } });
  if (!message) {
    return { status: "not_found" };
  }
  if (message.role !== "customer" || message.repliedAt) {
    return { status: "skipped" };
  }

  const thread = await prisma.messengerThread.findUnique({ where: { psid: message.psid } });

  // Most-recent window, then chronological for the LLM. History is cut at the
  // current mid so rapid follow-ups are answered by their own tasks in order.
  const recentRows = await prisma.messengerMessage.findMany({
    where: { psid: message.psid },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  const historyRows = [...recentRows].reverse();

  const now = new Date();
  const system = buildSystemPrompt(now);
  const messages = historyToLlmMessages(historyRows, mid);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    // The conversation must end on the customer's message for the LLM turn.
    return { status: "skipped" };
  }

  let finalText = "";
  let lastOpenSlots: Extract<GetAvailableDeliverySlotsResult, { available: true }> | null = null;

  for (let iteration = 0; iteration < MAX_LLM_ITERATIONS; iteration += 1) {
    const turn = await runLlmTurn({ system, messages, tools: MESSENGER_AGENT_TOOLS });
    if (!turn.ok) {
      if (turn.notConfigured || turn.error === MESSENGER_LLM_NOT_CONFIGURED_MESSAGE) {
        console.error("[messenger-agent] LLM not configured — dropping turn");
        return { status: "not_configured" };
      }
      return { status: "retryable_failure", error: turn.error };
    }

    const toolUses = turn.blocks.filter(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );

    if (toolUses.length === 0) {
      finalText = turn.blocks
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      break;
    }

    // Append the assistant tool-use turn, execute every call, and return all
    // results in ONE user message (parallel tool-use contract).
    messages.push({ role: "assistant", content: turn.blocks as LlmContentBlock[] });
    const results: LlmContentBlock[] = [];
    for (const toolUse of toolUses) {
      const result = await executeAgentTool(toolUse.name, toolUse.input, now);
      console.log(`[messenger-agent] tool ${toolUse.name} mid=${mid}`);
      if (toolUse.name === "get_available_slots" && isOpenSlotsResult(result)) {
        lastOpenSlots = result;
      }
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: results });
  }

  if (!finalText) {
    return { status: "retryable_failure", error: "LLM produced no final text within the tool-loop limit." };
  }

  const needsDisclosure = thread ? !thread.disclosedBot : true;
  const replyText = `${needsDisclosure ? `${BOT_DISCLOSURE}\n` : ""}${finalText}`.slice(
    0,
    MESSENGER_TEXT_LIMIT,
  );

  const quickReplies = lastOpenSlots
    ? lastOpenSlots.slots.slice(0, QUICK_REPLY_LIMIT).map((slot) => ({
        title: slot.label.slice(0, QUICK_REPLY_TITLE_LIMIT),
        payload: `SLOT_${slot.value}`,
      }))
    : undefined;

  let sendResult: Awaited<ReturnType<typeof sendMessengerTextMessage>>;
  try {
    sendResult = await sendMessengerTextMessage({
      psid: message.psid,
      text: replyText,
      quickReplies,
    });
  } catch (error) {
    return {
      status: "retryable_failure",
      error: error instanceof Error ? error.message : "Messenger send threw.",
    };
  }

  if (!sendResult.ok) {
    if (sendResult.error === MESSENGER_NOT_CONFIGURED_MESSAGE) {
      return { status: "not_configured" };
    }
    return { status: "retryable_failure", error: sendResult.error };
  }

  // The reply is out — from here on this attempt MUST report success, or a
  // Cloud Tasks retry would send a duplicate.
  try {
    await prisma.messengerMessage.update({
      where: { mid },
      data: { repliedAt: new Date(), replyMid: sendResult.messageId },
    });
    await prisma.messengerMessage.create({
      data: {
        psid: message.psid,
        role: "bot",
        bodyJson: JSON.stringify({ text: replyText }),
        mid: sendResult.messageId,
      },
    });
    if (needsDisclosure) {
      await prisma.messengerThread.update({
        where: { psid: message.psid },
        data: { disclosedBot: true },
      });
    }
  } catch (error) {
    console.warn(
      `[messenger-agent] reply bookkeeping failed for mid=${mid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  return { status: "sent", replyMid: sendResult.messageId };
}
