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
import type { MessengerProduct, SearchShopProductsResult } from "./messenger-products.server";
import { buildOrderSummaryText, confirmMessengerOrder } from "./messenger-orders.server";
import type { UpdateOrderStateResult } from "./messenger-orders.server";
import {
  MESSENGER_NOT_CONFIGURED_MESSAGE,
  sendMessengerGenericTemplate,
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

// Phase-6 ordering is env-gated: the read/write_draft_orders scopes need a
// config deploy + merchant re-approval before draft creation can work, so the
// bot must not OFFER ordering until the merchant flips this on.
export function messengerOrdersEnabled(): boolean {
  return process.env.MESSENGER_ORDERS_ENABLED?.trim() === "true";
}

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

function buildSystemPrompt(now: Date, ordersEnabled: boolean): string {
  return [
    "You are FlowerBot, the customer service and sales assistant of The Flowercart, a flower shop in the Philippines that delivers within Metro Manila.",
    "",
    "STYLE (merchant-tuned — follow strictly):",
    "- MIRROR the customer's tone of voice: match their formality, their Tagalog-English mix, and their energy. If they text casually, reply casually; if they write in English, lean English.",
    "- Use EVERYDAY words; when a Tagalog word is deep or formal, use the common English word instead (say 'estimate', never 'tantiya').",
    "- FORMAT for easy reading, Messenger-style: short paragraphs with a blank line between thoughts — never one dense block of text. Lists (slots, dates) go on their own lines.",
    "- Answer what was asked; skip facts the customer didn't ask about unless it directly blocks their request.",
    "- PLAIN TEXT ONLY: Messenger does not render markdown. Never write **bold**, *italics*, [links](url), or # headings — asterisks show up literally to the customer. Bare URLs and simple '-' lists are fine.",
    "",
    `Current date and time in Asia/Manila: ${getManilaNowLabel(now)}. All dates are in Asia/Manila.`,
    "",
    "HARD RULES:",
    "- Never state a price, availability, or delivery date that did not come from a tool result in the current turn.",
    "- Never compute a calendar date yourself. When the customer mentions a delivery date in any form, call resolve_date with the phrase structure.",
    "- After resolving a date, always echo it back WITH the weekday (e.g. \"Huwebes, Dec 24\") so the customer can catch a wrong parse.",
    "- Delivery time slots come ONLY from get_available_slots, and only for a resolved date. Never invent or offer a slot that is not in the tool result.",
    "- If the requested date is closed or full, offer the nearest available dates from the tool result.",
    "- Messages prefixed [HUMAN AGENT] were written by a real person from The Flowercart (not by you) — stay consistent with what they told the customer and never contradict them.",
    "",
    ...(ordersEnabled
      ? []
      : [
          "- You cannot take orders or payments yet. If asked, say the ordering assistant is 'malapit na' and offer to check delivery dates, or hand them to the page for now.",
          "",
        ]),
    ...(ordersEnabled
      ? [
          "ORDERING (you CAN take orders — collected step by step, saved by update_order):",
          "- Details are collected in this exact order: bouquet → delivery date → time slot → recipient name → delivery address → recipient phone; card message and special instructions are optional. Ask ONLY for the next missing detail (the update_order result's 'missing' list is the source of truth for what has been collected — never rely on your own memory of the conversation).",
          "- Call update_order EVERY time the customer gives or changes an order detail. The code validates and SAVES each field; a detail you did not pass to update_order does not exist.",
          "- Product: pass the variant_id from search_products / get_product_details (or a [TAP] PRODUCT_ payload). Date: resolve_date first, then pass the ISO date. Slot: pass the exact slot value (a [TAP] SLOT_ payload carries it after 'SLOT_').",
          "- Address: also pass address_area (barangay/city) or address_zip so coverage is checked. If the address is rejected as outside coverage, apologize and point to https://flowercart.store/pages/delivery-coverage.",
          "- To CHANGE a detail ('baguhin ang petsa'), call update_order with clear=[that field] plus the new value if given. Never restart the whole order; everything else stays saved.",
          "- When update_order returns readyToConfirm=true, a formatted order summary with a Confirm button is sent AUTOMATICALLY right after your reply — keep your text to one short line (e.g. 'Paki-check po ang summary sa baba 👇'), do NOT repeat the details, and do NOT say the order is placed.",
          "- The order is placed ONLY after the customer taps Confirm; the system then creates it and sends the secure Shopify checkout link where they pay (online via Xendit or per the COD rules). Never claim an order is confirmed, reserved, or placed before that tap.",
          "",
        ]
      : []),
    "PRODUCT DISCOVERY:",
    "- When the customer asks about products, available bouquets, prices, recommendations, or a budget, ALWAYS call search_products (use max_price/min_price for budgets like 'below 1000'). 'Ano mga available na bouquet niyo?' = search_products with no filters — never answer product questions from general knowledge or by just linking the website.",
    "- A product carousel (photos, live prices, buttons) is sent AUTOMATICALLY right after your reply whenever search_products returns products — so keep your text short (isang maikling intro lang, e.g. 'Heto po ang mga maganda naming options 🌸') and NEVER list the product names or prices in your text.",
    "- If search_products returns zero products, say walang exact match at i-suggest ang website, or ask for a different budget/keyword.",
    "- The cards have NO buttons (tap on the picture opens the product page). The customer PICKS a bouquet by typing its name (e.g. 'yung Sweet Heart' or 'kunin ko na yung Autumn Morning'): call search_products with that name as the query AND purpose='lookup' (no carousel is sent for a lookup), and when it clearly matches one product, confirm it with the LIVE price and offer the next step.",
    "- A customer message that starts with [TAP] is a button tap, not typed text. [TAP] PRODUCT_<variantId> means they picked that product from an older card: ALWAYS call get_product_details with that variant id first (the card may be old — never trust its price), then confirm with the LIVE price.",
    "- If get_product_details says the variant is unavailable or not found, apologize briefly and offer to search alternatives.",
    "- If you cannot help or the customer asks for a human, tell them a person from The Flowercart will follow up in this thread.",
    "",
    "STORE KNOWLEDGE (merchant-provided facts — you may state these):",
    "- Delivery fee: QUOTE the estimatedFeePhp from check_delivery_coverage as an estimate (e.g. 'around P250 po'), always with a short note that the exact fee shows at checkout. It mirrors the distance-based checkout rate, kaya pwede itong sumagot per barangay/district — if the customer names a specific barangay, look it up for a closer estimate. Use flatFeePhp only when the match has no estimatedFeePhp. Never quote a fee without the tool.",
    "- Some covered towns are OUTSIDE Metro Manila (marked provincial in the tool result): covered at may same-day delivery din — if asked, say yes we do same-day delivery po (same slots and cutoff as Metro Manila).",
    "- If the tool returns BOTH a Metro Manila match and a provincial match for the same name (e.g. Dasmarinas Village Makati vs Dasmarinas Cavite), ask the customer which one they mean before quoting.",
    "- FREE SHIPPING on orders P2,500 and up.",
    "- Payment methods: online via Xendit (cards, GCash, Maya, GrabPay, bank transfer, QRPh) or Cash on Delivery. COD is available for METRO MANILA addresses only — no COD for provincial areas (Bulacan/Rizal/Cavite/Laguna towns), online payment lang doon. COD has an extra P70 fee added automatically to the total, is available only for orders up to P2,500, and rider booking can take a bit longer on COD. For orders above P2,500 na gusto pa rin ng COD: split payment ang arrangement — the excess is paid online (GCash/Maya) and the rest COD.",
    "- About the shop: The Flowercart is a Metro Manila-based online flower shop — fresh rose bouquets and floral arrangements for all occasions (birthdays, anniversaries, graduations, romantic surprises), with same-day delivery. Website: https://flowercart.store",
    "- Store hours: 9:00 AM to 5:00 PM daily (NOT 24 hours). Store/pickup location: 255 Kawit St, Tondo, Manila. Pickup is welcome — earliest 9:00 AM; ask the customer to say when they plan to drop by so the order is ready.",
    "- Surprise deliveries are welcome: the customer can give rider instructions like 'do not call the recipient' or 'call the sender first'.",
    "- Complete order details (for when they order): bouquet name, recipient name, recipient contact number, delivery address, delivery date and time slot, card message, and any special instructions (optional).",
    "- Delivery coverage details: https://flowercart.store/pages/delivery-coverage — FAQs: https://flowercart.store/pages/faqs",
    "- Contact channels: phone 0962 422 4085, email hello@flowercart.store, or this Messenger chat. Website chat is also available.",
    "- Self-service account page https://flowercart.store/account: track order, reschedule delivery, update address, update phone number. Point customers there for those requests (log in with the email/phone used at checkout).",
    "- Tracking: a real-time tracking link is emailed once the order is dispatched, and a delivery confirmation email follows after a successful delivery.",
    "- Cancellation: advance orders can be cancelled up to 12:00 PM one day before the delivery date — full refund issued as store credit valid 12 months. Same-day orders may no longer be cancellable once processing starts.",
    "- Problems with a delivered order (wrong/damaged bouquet): report within 24 hours of delivery with the order number and photos — via phone, email, or this chat. Approved refunds are processed within 3-7 working days.",
    "- Delivery handoff: direct-to-recipient is not guaranteed — the bouquet may be left with a receptionist, guard, or family member per the location's policy. Hospital deliveries are OK (include ward and bed number; make sure the patient has not been discharged). No P.O. box deliveries.",
    "- If the customer gave wrong delivery details: the shop is not liable for the failed attempt; re-delivery on the next available slot has a re-delivery fee. Corrections should be sent within 24 hours.",
    "- Flowers available: roses, sunflowers, daisies, gerberas, carnations, tulips, and more. Fresh flowers last around 3-7 days with care (tulips 1-2 days). Slightly droopy on arrival is normal — trim the stems and give them water overnight. Care guide: https://flowercart.store/pages/flower-care",
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
    // Operator rows (phase 7 human takeover) reach the LLM as assistant turns
    // tagged [HUMAN AGENT] so the bot never contradicts what the human said.
    const isAssistant = row.role === "bot" || row.role === "operator";
    messages.push({
      role: isAssistant ? "assistant" : "user",
      content: [{ type: "text", text: row.role === "operator" ? `[HUMAN AGENT] ${text}` : text }],
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

function isProductsResult(value: unknown): value is Extract<SearchShopProductsResult, { ok: true }> {
  const candidate = value as { ok?: boolean; products?: unknown };
  return candidate?.ok === true && Array.isArray(candidate.products);
}

function isOrderUpdateResult(value: unknown): value is Extract<UpdateOrderStateResult, { ok: true }> {
  const candidate = value as { ok?: boolean; readyToConfirm?: unknown; state?: unknown };
  return (
    candidate?.ok === true &&
    typeof candidate.readyToConfirm === "boolean" &&
    typeof candidate.state === "object" &&
    candidate.state !== null
  );
}

// Deterministic CONFIRM path (phase 6): the [TAP] CONFIRM_ORDER_<key> payload
// is handled by CODE — the LLM never decides whether an order is created.
const CONFIRM_TAP_PATTERN = /^\[TAP\]\s+CONFIRM_ORDER_(.+)$/;

const EDIT_ORDER_PAYLOAD = "EDIT_ORDER";

function formatPricePhp(price: number): string {
  return `₱${price.toLocaleString("en-PH")}`;
}

// Messenger renders plain text only. The prompt already forbids markdown, but
// the LLM slips (live 2026-08-02 smoke test: customers saw literal asterisks)
// — so the code strips it deterministically before every send.
export function sanitizeMessengerText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?):;])/gm, "$1$2");
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

  // Most-recent window, then chronological for the LLM. History is cut at the
  // current mid so rapid follow-ups are answered by their own tasks in order.
  const recentRows = await prisma.messengerMessage.findMany({
    where: { psid: message.psid },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  const historyRows = [...recentRows].reverse();

  const ordersEnabled = messengerOrdersEnabled();
  const system = buildSystemPrompt(now, ordersEnabled);
  const tools = ordersEnabled
    ? MESSENGER_AGENT_TOOLS
    : MESSENGER_AGENT_TOOLS.filter((tool) => tool.name !== "update_order");
  const messages = historyToLlmMessages(historyRows, mid);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    // The conversation must end on the customer's message for the LLM turn.
    return { status: "skipped" };
  }

  let finalText = "";
  let lastOpenSlots: Extract<GetAvailableDeliverySlotsResult, { available: true }> | null = null;
  let lastProducts: MessengerProduct[] | null = null;
  let lastOrderReady: { orderKey: string; summaryText: string } | null = null;

  for (let iteration = 0; iteration < MAX_LLM_ITERATIONS; iteration += 1) {
    const turn = await runLlmTurn({ system, messages, tools });
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
      const result = await executeAgentTool(toolUse.name, toolUse.input, now, {
        psid: message.psid,
      });
      console.log(`[messenger-agent] tool ${toolUse.name} mid=${mid}`);
      if (toolUse.name === "get_available_slots" && isOpenSlotsResult(result)) {
        lastOpenSlots = result;
      }
      if (toolUse.name === "search_products" && isProductsResult(result) && result.products.length) {
        // purpose="lookup" = the customer is PICKING a named bouquet, not
        // browsing — a carousel there is noise (live smoke-test feedback).
        const purpose = (toolUse.input as { purpose?: unknown } | null)?.purpose;
        lastProducts = purpose === "lookup" ? null : result.products;
      }
      if (toolUse.name === "update_order" && isOrderUpdateResult(result)) {
        // The LATEST update decides: a later edit in the same turn can move
        // the state back to collecting, dropping the confirm prompt.
        lastOrderReady =
          result.readyToConfirm && result.orderKey
            ? { orderKey: result.orderKey, summaryText: buildOrderSummaryText(result.state) }
            : null;
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

  // Order ready → append the DETERMINISTIC summary (never the LLM's wording)
  // and attach the Confirm / Baguhin quick replies (master doc Commitment
  // rule: no draft order without an explicit confirmation tap).
  let replyText = finalText;
  let quickReplies: MessengerQuickReply[] | undefined;
  if (lastOrderReady) {
    replyText = `${finalText}\n\n${lastOrderReady.summaryText}`;
    quickReplies = [
      { title: "Confirm ✅", payload: `CONFIRM_ORDER_${lastOrderReady.orderKey}` },
      { title: "Baguhin", payload: EDIT_ORDER_PAYLOAD },
    ];
  } else if (lastOpenSlots && !lastProducts) {
    // A carousel message right after would dismiss quick replies in the UI —
    // a product turn keeps the carousel and drops the slot buttons.
    quickReplies = lastOpenSlots.slots.slice(0, QUICK_REPLY_LIMIT).map((slot) => ({
      title: slot.label.slice(0, QUICK_REPLY_TITLE_LIMIT),
      payload: `SLOT_${slot.value}`,
    }));
  }

  return deliverReplyAndBookkeep({
    psid: message.psid,
    mid,
    replyText,
    quickReplies,
    needsDisclosure,
    // A carousel after the summary would dismiss the Confirm quick replies.
    products: lastOrderReady ? null : lastProducts,
  });
}
