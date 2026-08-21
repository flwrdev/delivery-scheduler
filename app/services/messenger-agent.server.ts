// The MESSENGER ADAPTER for the FlowerCart agent (phase 4, rewired in the
// extensions phase-2 modernization).
//
// The LLM handles LANGUAGE. The tool loop lives in agent-core.server.ts and is
// shared with the other channels. What stays HERE is everything Meta-shaped:
// the repliedAt zero-duplicate guarantee, the humanControl mute + auto-handback,
// the deterministic CONFIRM tap, the typing indicator, Prisma history loading
// (including image attachments), the Send API call, and the abandoned-order
// follow-up. In short: this file owns the TRANSPORT, agent-core owns the BRAIN.
//
// The translation layer in the middle is the interesting part — the core hands
// back neutral AgentBlocks and this file turns them into Messenger primitives
// (quick replies capped at 13 buttons / 20 chars, a generic-template carousel),
// keeping the precedence the live bot has always had: summary > add-on choices
// > slots, and NO carousel behind a summary (it would dismiss the Confirm
// button in the Meta UI and the customer could not place the order).
//
// Log hygiene: mids, psids, statuses, tool names, error strings — never
// message text or LLM output.

import prisma from "../db.server";
import {
  AGENT_NO_FINAL_TEXT_ERROR,
  runAgentTurn,
} from "./agent-core.server";
import { MESSENGER_CAPABILITIES } from "./agent-channel";
import type { AgentBlock } from "./agent-channel";
import { sanitizeMessengerText } from "./agent-prompt.server";
import type { LlmContentBlock, LlmMessage } from "./messenger-llm.server";
import type { MessengerProduct } from "./messenger-products.server";
import { claimOrderFollowUp, confirmMessengerOrder } from "./messenger-orders.server";
import { enqueueMessengerFollowUpTask } from "./messenger-queue.server";
import {
  MESSENGER_NOT_CONFIGURED_MESSAGE,
  sendMessengerGenericTemplate,
  sendMessengerSenderAction,
  sendMessengerTextMessage,
} from "./messenger-send.server";
import type { MessengerQuickReply } from "./messenger-send.server";

// Messenger rejects text messages longer than 2000 chars.
const MESSENGER_TEXT_LIMIT = 2000;
// Quick replies: max 13 buttons, 20 chars per title (Messenger hard limits).
const QUICK_REPLY_LIMIT = 13;
const QUICK_REPLY_TITLE_LIMIT = 20;
// Conversation context window (rows) pulled from Neon per turn.
const HISTORY_LIMIT = 20;

const BOT_DISCLOSURE =
  "🌸 Ako po si FlowerBot, ang automated assistant ng The Flowercart.";

export type ProcessAgentTurnResult =
  | { status: "sent"; replyMid: string }
  | { status: "skipped" }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "retryable_failure"; error: string };

// The prompt + plain-text hygiene moved to agent-prompt.server.ts so the shared
// brain can use them without importing this Meta-specific module (a cycle a
// bundler can break at runtime). Re-exported here because tests, the eval path,
// and older callers import them from this module — walang import na nasira.
export {
  buildDynamicContext,
  buildStaticSystemPrompt,
  buildSystemPrompt,
  messengerOrdersEnabled,
  sanitizeMessengerText,
} from "./agent-prompt.server";

// Phase 7 auto-handback window: after N hours with NO operator message on the
// thread (every operator echo refreshes humanControlAt), the bot resumes on
// the next customer message. Garbage/absent env falls back to the default.
const DEFAULT_HANDBACK_HOURS = 6;

export function messengerHandbackHours(): number {
  const raw = process.env.MESSENGER_HANDBACK_HOURS?.trim();
  if (!raw) {
    return DEFAULT_HANDBACK_HOURS;
  }
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HANDBACK_HOURS;
}

// Abandoned-order follow-up (2026-08-03): ilang oras pagkatapos ng summary
// bago ang isang beses na reminder. 0 = naka-off. Default 3h — komportableng
// nasa loob ng Meta 24-hour messaging window.
const DEFAULT_FOLLOWUP_HOURS = 3;

export function messengerFollowUpHours(): number {
  const raw = process.env.MESSENGER_FOLLOWUP_HOURS?.trim();
  if (!raw) {
    return DEFAULT_FOLLOWUP_HOURS;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_FOLLOWUP_HOURS;
  }
  return hours;
}

interface StoredMessageRow {
  role: string;
  bodyJson: string;
  mid: string;
}

// Phase 12: image attachments are recorded as "[IMAGE] <url>" lines in the
// message text. Only the CURRENT message's images are fetched for the LLM
// (Meta CDN urls expire and refetching history every turn is waste); older
// rows degrade to a placeholder line so the context still notes a photo.
const IMAGE_LINE_PATTERN = /^\[IMAGE\] (https:\/\/\S+)$/;

function splitImageLines(text: string): { text: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = IMAGE_LINE_PATTERN.exec(line.trim());
    if (match) {
      imageUrls.push(match[1]);
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trim(), imageUrls };
}

const IMAGE_FETCH_TIMEOUT_MS = 8_000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function fetchImageAsLlmBlock(url: string): Promise<LlmContentBlock | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    const mediaType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) {
      return null;
    }
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
    };
  } catch {
    return null;
  }
}

async function historyToLlmMessages(
  rows: StoredMessageRow[],
  currentMid: string,
): Promise<LlmMessage[]> {
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
    // Operator rows (phase 7 human takeover) reach the LLM as assistant turns
    // tagged [HUMAN AGENT] so the bot never contradicts what the human said.
    const isAssistant = row.role === "bot" || row.role === "operator";
    const isCurrent = row.mid === currentMid;
    const content: LlmContentBlock[] = [];
    if (!isAssistant && text.includes("[IMAGE] ")) {
      const { text: caption, imageUrls } = splitImageLines(text);
      if (isCurrent) {
        let loaded = 0;
        for (const url of imageUrls.slice(0, 3)) {
          const block = await fetchImageAsLlmBlock(url);
          if (block) {
            content.push(block);
            loaded += 1;
          }
        }
        const note =
          loaded > 0
            ? "[Nagpadala ang customer ng larawan — nasa itaas.]"
            : "[Nagpadala ang customer ng larawan pero hindi ito ma-load.]";
        content.push({ type: "text", text: caption ? `${note}\n${caption}` : note });
      } else {
        content.push({
          type: "text",
          text: caption
            ? `[Nagpadala ang customer ng larawan.]\n${caption}`
            : "[Nagpadala ang customer ng larawan.]",
        });
      }
    } else {
      content.push({
        type: "text",
        text: row.role === "operator" ? `[HUMAN AGENT] ${text}` : text,
      });
    }
    messages.push({ role: isAssistant ? "assistant" : "user", content });
    if (isCurrent) {
      break;
    }
  }
  return messages;
}

// Deterministic CONFIRM path (phase 6): the [TAP] CONFIRM_ORDER_<key> payload
// is handled by CODE — the LLM never decides whether an order is created.
const CONFIRM_TAP_PATTERN = /^\[TAP\]\s+CONFIRM_ORDER_(.+)$/;

const EDIT_ORDER_PAYLOAD = "EDIT_ORDER";

function formatPricePhp(price: number): string {
  return `₱${price.toLocaleString("en-PH")}`;
}

// Merchant decision (2026-08-02): WALANG buttons sa cards — natatakpan ng
// dalawang malaking button ang picture. Tap sa picture mismo = product page;
// ang in-chat na pagpili ay sa pag-type ng bouquet name.
function productCarouselElements(products: MessengerProduct[]) {
  return products
    .filter((product) => product.variantId)
    .map((product) => ({
      title: product.productTitle,
      subtitle: `${formatPricePhp(product.pricePhp)}${product.available ? "" : " — out of stock"}`,
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
      ...(product.url ? { defaultActionUrl: product.url } : {}),
    }));
}

interface DeliverReplyArgs {
  psid: string;
  mid: string;
  replyText: string;
  quickReplies?: MessengerQuickReply[];
  needsDisclosure: boolean;
  /** Optional best-effort product carousel sent after the text. */
  products?: MessengerProduct[] | null;
}

// Shared send + bookkeeping tail for both the LLM path and the deterministic
// confirm path. Once the text send succeeds this MUST report success — a
// Cloud Tasks retry after that point would send a duplicate.
async function deliverReplyAndBookkeep({
  psid,
  mid,
  replyText,
  quickReplies,
  needsDisclosure,
  products,
}: DeliverReplyArgs): Promise<ProcessAgentTurnResult> {
  const finalReplyText = `${needsDisclosure ? `${BOT_DISCLOSURE}\n` : ""}${sanitizeMessengerText(
    replyText,
  )}`.slice(0, MESSENGER_TEXT_LIMIT);

  let sendResult: Awaited<ReturnType<typeof sendMessengerTextMessage>>;
  try {
    sendResult = await sendMessengerTextMessage({
      psid,
      text: finalReplyText,
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

  // The reply is out — the carousel is best-effort: a failure after the text
  // send must never trigger a retry.
  if (products) {
    const elements = productCarouselElements(products);
    if (elements.length) {
      const carousel = await sendMessengerGenericTemplate({ psid, elements });
      if (carousel.ok) {
        console.log(`[messenger-agent] product carousel sent mid=${mid} elements=${elements.length}`);
      } else {
        console.warn(`[messenger-agent] product carousel failed mid=${mid}: ${carousel.error}`);
      }
    }
  }

  try {
    await prisma.messengerMessage.update({
      where: { mid },
      data: { repliedAt: new Date(), replyMid: sendResult.messageId },
    });
    await prisma.messengerMessage.create({
      data: {
        psid,
        role: "bot",
        bodyJson: JSON.stringify({ text: finalReplyText }),
        mid: sendResult.messageId,
      },
    });
    if (needsDisclosure) {
      await prisma.messengerThread.update({
        where: { psid },
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

// The confirm tap runs WITHOUT the LLM: code decides creation, code composes
// the reply. Transient create failures surface as retryable_failure so the
// Cloud Tasks retry re-runs the idempotent create (check-before-create makes
// the replay converge on one draft order).
async function processConfirmTap(
  psid: string,
  mid: string,
  orderKey: string,
  needsDisclosure: boolean,
): Promise<ProcessAgentTurnResult> {
  const result = await confirmMessengerOrder(psid, orderKey);
  console.log(
    `[messenger-agent] confirm tap mid=${mid} ok=${result.ok}${result.ok ? "" : ` code=${result.code}`}`,
  );

  if (!result.ok && result.code === "transient") {
    return { status: "retryable_failure", error: result.error };
  }

  let replyText: string;
  if (result.ok) {
    replyText = [
      result.alreadyCreated
        ? "Na-create na po ang order ninyo kanina pa — heto ulit ang payment link:"
        : `Salamat po! Na-create na ang order ninyo${
            result.draftOrderName ? ` (${result.draftOrderName})` : ""
          }. 🎉`,
      "",
      "Bayaran po dito para ma-book ang delivery (secure Shopify checkout):",
      result.invoiceUrl,
      "",
      "Naka-reserve po ang bulaklak ng 15 minutes habang nagbabayad. Kapag nakabayad na, makakatanggap kayo ng confirmation email.",
    ].join("\n");
  } else if (result.code === "incomplete") {
    replyText =
      "May kulang pa po sa order details kaya hindi pa ito ma-confirm. Ituloy lang po natin — sabihin niyo lang ang susunod na detalye. 🌸";
  } else if (result.code === "stale_key") {
    replyText =
      "Mukhang luma na po ang Confirm button na iyan (may binago tayo sa order). Paki-review ulit ang latest na summary bago i-confirm. 🌸";
  } else {
    replyText =
      "Pasensya na po — nagka-technical issue sa pag-create ng order. Subukan ulit i-tap ang Confirm mamaya, o mag-iwan ng message at may taga-Flowercart na tutulong sa inyo.";
  }

  return deliverReplyAndBookkeep({ psid, mid, replyText, needsDisclosure });
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
  let needsDisclosure = thread ? !thread.disclosedBot : true;

  const now = new Date();

  // Phase 7 — human takeover mute. While the operator has the thread the bot
  // KEEPS LISTENING (the row is already recorded) but never calls the LLM and
  // never sends. Skipped turns must NOT set repliedAt (zero-duplicate
  // contract untouched; the worker answers 200 for skipped).
  if (thread?.humanControl) {
    const takenOverAt = thread.humanControlAt?.getTime();
    const handbackMs = messengerHandbackHours() * 60 * 60 * 1000;
    const expired = takenOverAt !== undefined && now.getTime() - takenOverAt >= handbackMs;
    if (!expired) {
      // No timestamp (manual DB edit) also stays muted — the merchant's
      // manual Resume toggle is the recovery path.
      console.log(`[messenger-agent] humanControl active psid=${message.psid} — skipped mid=${mid}`);
      return { status: "skipped" };
    }
    // Auto-handback: N hours with no operator message. Clear the flag and
    // force re-disclosure — Meta policy requires the bot to re-disclose after
    // a human handoff.
    try {
      await prisma.messengerThread.update({
        where: { psid: message.psid },
        data: { humanControl: false, humanControlAt: null, disclosedBot: false },
      });
      console.log(`[messenger-agent] auto-handback psid=${message.psid} — bot resumed mid=${mid}`);
    } catch (error) {
      console.warn(
        `[messenger-agent] auto-handback update failed for psid=${message.psid}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    needsDisclosure = true;
  }

  // Deterministic CONFIRM path — never routed through the LLM.
  let inboundText = "";
  try {
    inboundText = String((JSON.parse(message.bodyJson) as { text?: unknown }).text ?? "");
  } catch {
    // Fall through — the history builder tolerates unparseable rows.
  }
  const confirmMatch = CONFIRM_TAP_PATTERN.exec(inboundText.trim());
  if (confirmMatch) {
    return processConfirmTap(message.psid, mid, confirmMatch[1].trim(), needsDisclosure);
  }

  // Phase 8 typing indicator: fire-and-forget bago ang LLM turn. Placement is
  // deliberate — AFTER the humanControl mute gate (walang typing sa muted
  // thread) and AFTER the deterministic confirm path (fast enough na hindi na
  // kailangan). Never awaited, result ignored (the send never throws by
  // design); Messenger clears the indicator automatically when the reply
  // arrives, kaya walang typing_off.
  void sendMessengerSenderAction({ psid: message.psid, action: "typing_on" });

  // Most-recent window, then chronological for the LLM. History is cut at the
  // current mid so rapid follow-ups are answered by their own tasks in order.
  const recentRows = await prisma.messengerMessage.findMany({
    where: { psid: message.psid },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  const historyRows = [...recentRows].reverse();

  const messages = await historyToLlmMessages(historyRows, mid);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    // The conversation must end on the customer's message for the LLM turn.
    return { status: "skipped" };
  }

  // THE BRAIN — one call. The prompt split, the 5-iteration ceiling, the tool
  // dispatch, and the affordance precedence all live in agent-core now; this
  // file only says WHO is asking and translates the answer back to Meta.
  const turn = await runAgentTurn({
    channel: {
      kind: "messenger",
      identity: { type: "psid", psid: message.psid },
      threadId: message.psid,
      supports: MESSENGER_CAPABILITIES,
    },
    messages,
    now,
    // Deliberate: the live Messenger tool contract passes `{ psid }`, and this
    // rewire must not change a single production call shape. update_order reads
    // `threadId ?? psid`, kaya pareho ang naaabot na row.
    toolContext: { psid: message.psid },
  });

  if (!turn.ok) {
    if (turn.notConfigured) {
      console.error("[messenger-agent] LLM not configured — dropping turn");
      return { status: "not_configured" };
    }
    // Everything else (upstream 5xx, the tool-loop ceiling, an empty answer) is
    // worth ONE more Cloud Tasks attempt — repliedAt is still unset.
    return { status: "retryable_failure", error: turn.error };
  }

  // --- AgentBlock[] → Messenger primitives ---------------------------------
  //
  // Explicit lookups, not a switch over the block order: the precedence below
  // is a PRODUCT rule (summary > add-on choices > slots, and never a carousel
  // behind a summary), so it must not depend on which order the core happens to
  // emit the blocks in.
  const blocks: AgentBlock[] = turn.reply.blocks;
  const textBlock = blocks.find((block): block is Extract<AgentBlock, { type: "text" }> =>
    block.type === "text",
  );
  const summaryBlock = blocks.find((block): block is Extract<AgentBlock, { type: "summary" }> =>
    block.type === "summary",
  );
  const choicesBlock = blocks.find((block): block is Extract<AgentBlock, { type: "choices" }> =>
    block.type === "choices",
  );
  const slotsBlock = blocks.find((block): block is Extract<AgentBlock, { type: "slots" }> =>
    block.type === "slots",
  );
  const productsBlock = blocks.find((block): block is Extract<AgentBlock, { type: "products" }> =>
    block.type === "products",
  );

  let replyText = textBlock?.text ?? "";
  if (!replyText) {
    // Defensive: the core already treats an empty answer as a designed failure.
    return { status: "retryable_failure", error: AGENT_NO_FINAL_TEXT_ERROR };
  }

  let quickReplies: MessengerQuickReply[] | undefined;
  if (summaryBlock) {
    // Order ready → append the DETERMINISTIC summary (never the LLM's wording)
    // and attach the Confirm / Baguhin quick replies (master doc Commitment
    // rule: no draft order without an explicit confirmation tap).
    replyText = `${replyText}\n\n${summaryBlock.text}`;
    quickReplies = [
      { title: "Confirm ✅", payload: `CONFIRM_ORDER_${summaryBlock.orderKey}` },
      { title: "Baguhin", payload: EDIT_ORDER_PAYLOAD },
    ];
  } else if (choicesBlock) {
    // Add-on category buttons — ang [TAP] ADDON_* payloads ay hina-handle ng
    // LLM sa susunod na turn (search per category o decline).
    quickReplies = choicesBlock.options
      .slice(0, QUICK_REPLY_LIMIT)
      .map((option) => ({
        title: option.label.slice(0, QUICK_REPLY_TITLE_LIMIT),
        payload: option.payload,
      }));
  } else if (slotsBlock) {
    // The core hands back the FULL slot list; the 13-button / 20-char caps are
    // Meta's, so they are applied here.
    quickReplies = slotsBlock.slots.slice(0, QUICK_REPLY_LIMIT).map((slot) => ({
      title: slot.label.slice(0, QUICK_REPLY_TITLE_LIMIT),
      payload: `SLOT_${slot.value}`,
    }));
  }

  const delivered = await deliverReplyAndBookkeep({
    psid: message.psid,
    mid,
    replyText,
    quickReplies,
    needsDisclosure,
    // A carousel after the summary would dismiss the Confirm quick replies —
    // the core already suppresses the products block in that case, and this
    // guard keeps the rule true even if that ever changes.
    products: summaryBlock ? null : ((productsBlock?.items as MessengerProduct[]) ?? null),
  });

  // Abandoned-order follow-up (2026-08-03): kapag lumabas ang summary + Confirm,
  // mag-schedule ng isang delayed reminder task. Best-effort — hindi kailanman
  // pinapalya nito ang turn; ang worker guards ang magpapasya kung sesend pa.
  if (delivered.status === "sent" && summaryBlock) {
    const hours = messengerFollowUpHours();
    if (hours > 0) {
      try {
        const enqueued = await enqueueMessengerFollowUpTask({
          psid: message.psid,
          orderKey: summaryBlock.orderKey,
          delaySeconds: Math.round(hours * 3600),
        });
        if (enqueued.ok) {
          console.log(
            `[messenger-agent] follow-up scheduled key=${summaryBlock.orderKey} in ${hours}h`,
          );
        } else if (!enqueued.notConfigured) {
          console.warn(`[messenger-agent] follow-up enqueue failed: ${enqueued.error}`);
        }
      } catch (error) {
        console.warn(
          `[messenger-agent] follow-up enqueue threw: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
  }

  return delivered;
}

// ---------------------------------------------------------------------------
// Abandoned-order follow-up (2026-08-03) — Cloud Tasks delayed reminder
// ---------------------------------------------------------------------------
//
// Tumatakbo pagkalipas ng MESSENGER_FOLLOWUP_HOURS mula nang lumabas ang order
// summary. Deterministic ang teksto (walang LLM). Guards bago mag-send:
//   1. humanControl OFF (walang nudge habang hawak ng tao ang thread),
//   2. may inbound customer message sa nakaraang 20h (Meta 24h window, may
//      margin) at WALA sa nakaraang 45 min (huwag sumabad sa aktibong usapan),
//   3. state ay awaiting_confirm pa rin sa PAREHONG orderKey at hindi pa
//      nasusundan (claimOrderFollowUp = mark-BEFORE-send, zero duplicates).

const FOLLOWUP_ACTIVE_CHAT_MS = 45 * 60 * 1000;
const FOLLOWUP_WINDOW_MS = 20 * 60 * 60 * 1000;

// Kapag pinaikli ang MESSENGER_FOLLOWUP_HOURS (test mode, < 90 min), ang
// fixed na 45-min guard ay laging lalamon sa maagang fire at hinding-hindi
// lalabas ang reminder — kaya kalahati ng delay ang guard, capped sa 45 min.
function followUpActiveChatMs(): number {
  const delayMs = messengerFollowUpHours() * 60 * 60 * 1000;
  return Math.min(FOLLOWUP_ACTIVE_CHAT_MS, delayMs / 2);
}

export async function processOrderFollowUp(
  psid: string,
  orderKey: string,
  now = new Date(),
): Promise<ProcessAgentTurnResult> {
  let thread;
  try {
    thread = await prisma.messengerThread.findUnique({ where: { psid } });
  } catch (error) {
    return {
      status: "retryable_failure",
      error: error instanceof Error ? error.message : "Could not load the thread.",
    };
  }
  if (!thread) {
    return { status: "not_found" };
  }
  if (thread.humanControl) {
    console.log(`[messenger-agent] follow-up skipped psid=${psid} — humanControl`);
    return { status: "skipped" };
  }

  let lastCustomer;
  try {
    lastCustomer = await prisma.messengerMessage.findFirst({
      where: { psid, role: "customer" },
      orderBy: { createdAt: "desc" },
    });
  } catch (error) {
    return {
      status: "retryable_failure",
      error: error instanceof Error ? error.message : "Could not load the thread history.",
    };
  }
  if (!lastCustomer) {
    return { status: "skipped" };
  }
  const sinceLastCustomerMs = now.getTime() - lastCustomer.createdAt.getTime();
  if (sinceLastCustomerMs > FOLLOWUP_WINDOW_MS) {
    console.log(`[messenger-agent] follow-up skipped psid=${psid} — outside the messaging window`);
    return { status: "skipped" };
  }
  if (sinceLastCustomerMs < followUpActiveChatMs()) {
    console.log(`[messenger-agent] follow-up skipped psid=${psid} — conversation is active`);
    return { status: "skipped" };
  }

  const claim = await claimOrderFollowUp(psid, orderKey);
  if (!claim.ok) {
    if (claim.reason === "error") {
      return { status: "retryable_failure", error: claim.error ?? "Follow-up claim failed." };
    }
    console.log(`[messenger-agent] follow-up skipped psid=${psid} — ${claim.reason}`);
    return { status: "skipped" };
  }

  const state = claim.state;
  const price =
    typeof state.pricePhp === "number" ? ` (₱${state.pricePhp.toLocaleString("en-PH")})` : "";
  const lines = [
    "Hi po! 👋 Naka-reserve pa po ang order niyo:",
    `💐 ${state.productTitle ?? "ang napili niyong bouquet"}${price}`,
    ...(state.deliveryDate && state.timeSlot
      ? [`📅 ${state.deliveryDate} • ${state.timeSlot}`]
      : []),
    "",
    "Ituloy ko na po ba? I-tap lang ang Confirm kung go na. 🌸",
  ];
  const text = sanitizeMessengerText(lines.join("\n")).slice(0, MESSENGER_TEXT_LIMIT);

  let sendResult;
  try {
    sendResult = await sendMessengerTextMessage({
      psid,
      text,
      quickReplies: [
        { title: "Confirm ✅", payload: `CONFIRM_ORDER_${orderKey}` },
        { title: "Baguhin", payload: EDIT_ORDER_PAYLOAD },
      ],
    });
  } catch (error) {
    // Claimed na — sadyang HINDI nire-retry para walang duplicate nudge.
    console.warn(
      `[messenger-agent] follow-up send threw psid=${psid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return { status: "skipped" };
  }
  if (!sendResult.ok) {
    console.warn(`[messenger-agent] follow-up send failed psid=${psid}: ${sendResult.error}`);
    return sendResult.error === MESSENGER_NOT_CONFIGURED_MESSAGE
      ? { status: "not_configured" }
      : { status: "skipped" };
  }

  try {
    await prisma.messengerMessage.create({
      data: {
        psid,
        role: "bot",
        bodyJson: JSON.stringify({ text }),
        mid: sendResult.messageId,
      },
    });
  } catch (error) {
    console.warn(
      `[messenger-agent] follow-up bookkeeping failed psid=${psid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  console.log(`[messenger-agent] follow-up sent psid=${psid} key=${orderKey}`);
  return { status: "sent", replyMid: sendResult.messageId };
}
