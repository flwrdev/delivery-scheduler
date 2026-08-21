// The transport-free agent brain (extensions phase 1).
//
// WHY: `processAgentTurnByMid` in messenger-agent.server.ts does FOUR jobs at
// once — Neon bookkeeping, the humanControl mute, the LLM tool loop, and the
// Meta Send API call. Only the third of those is channel-agnostic, and it is
// the expensive one to get right (prompt-cache split, 5-iteration ceiling,
// the "carousel after a summary dismisses the Confirm button" rules). This
// file is that third job, lifted out VERBATIM and re-expressed in the neutral
// AgentBlock vocabulary so customer accounts and the storefront can run the
// exact same brain.
//
// WHAT THIS FILE MUST NOT DO: no Prisma reads, no Meta sends, no repliedAt
// bookkeeping, no humanControl gate. Those are the CALLER's (each channel
// adapter's) job — the zero-duplicate guarantee lives with whoever owns the
// transport, and moving it in here would quietly duplicate it per channel.
//
// Status note: LIVE as of extensions phase 2 — messenger-agent.server.ts no
// longer keeps its own copy of the loop, it calls runAgentTurn and translates
// the AgentBlocks back into Messenger primitives (quick replies, carousel).
// A change here now moves production Messenger behaviour: test both
// test/agent-core.server.test.ts AND test/messenger-agent.server.test.ts.
//
// Log hygiene: tool names, channel kind, thread ids, counts, error strings —
// NEVER message text, never LLM output, never customer details.

import { loadCodFacts } from "./cod-facts.server";
import {
  executeAgentTool,
  MESSENGER_AGENT_TOOLS,
} from "./messenger-agent-tools.server";
import type {
  AgentToolContext,
  GetAvailableDeliverySlotsResult,
} from "./messenger-agent-tools.server";
import {
  buildDynamicContext,
  buildStaticSystemPrompt,
  buildSystemPrompt,
  messengerOrdersEnabled,
  sanitizeMessengerText,
} from "./agent-prompt.server";
import {
  MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
  runLlmTurn,
} from "./messenger-llm.server";
import type { LlmContentBlock, LlmMessage, LlmToolDefinition } from "./messenger-llm.server";
import { buildOrderSummaryText } from "./messenger-orders.server";
import type { UpdateOrderStateResult } from "./messenger-orders.server";
import type { MessengerProduct, SearchShopProductsResult } from "./messenger-products.server";
import type { AgentBlock, AgentChannel, AgentReply } from "./agent-channel";

// Tool-loop ceiling per inbound message — same number the Messenger loop uses.
// Five is enough for resolve_date -> get_available_slots -> update_order ->
// reply; anything past that is a model loop, not a real turn.
const MAX_LLM_ITERATIONS = 5;

// Add-on upsell buttons (2026-08-03): the CODE owns these four options, not the
// LLM — the prompt only tells it to make the offer once.
const ADD_ON_CHOICES: Array<{ label: string; payload: string }> = [
  { label: "🧸 Bear", payload: "ADDON_BEAR" },
  { label: "🍫 Chocolates", payload: "ADDON_CHOCOLATES" },
  { label: "🎈 Balloon", payload: "ADDON_BALLOON" },
  { label: "Hindi na po", payload: "ADDON_NONE" },
];

export const AGENT_NO_FINAL_TEXT_ERROR =
  "LLM produced no final text within the tool-loop limit.";

export interface RunAgentTurnInput {
  channel: AgentChannel;
  /** Chronological conversation history, already converted to LLM shape. */
  messages: LlmMessage[];
  now?: Date;
  /**
   * What the stateful tools get as their conversation key. Defaults to the
   * channel-agnostic `{ threadId }`, which is what a NEW adapter should use.
   * The LIVE Messenger adapter overrides it with `{ psid }` so the rewire onto
   * this core changes nothing about the call shape production already makes
   * (update_order reads `threadId ?? psid`, so both resolve to the same row).
   */
  toolContext?: AgentToolContext;
}

export type RunAgentTurnResult =
  | { ok: true; reply: AgentReply; toolsUsed: string[] }
  | { ok: false; error: string; notConfigured?: boolean };

// --- Tool-result narrowing --------------------------------------------------
//
// The loop only sees `unknown` back from executeAgentTool (it never throws, it
// returns designed failures), so every side-effect capture is guarded. These
// are the same three guards the Messenger loop uses; exported so the adapter
// layer can reuse them instead of re-deriving the shapes.

export function isOpenSlotsResult(
  value: unknown,
): value is Extract<GetAvailableDeliverySlotsResult, { available: true }> {
  const candidate = value as { ok?: boolean; available?: boolean; slots?: unknown };
  return candidate?.ok === true && candidate.available === true && Array.isArray(candidate.slots);
}

export function isProductsResult(
  value: unknown,
): value is Extract<SearchShopProductsResult, { ok: true }> {
  const candidate = value as { ok?: boolean; products?: unknown };
  return candidate?.ok === true && Array.isArray(candidate.products);
}

export function isOrderUpdateResult(
  value: unknown,
): value is Extract<UpdateOrderStateResult, { ok: true }> {
  const candidate = value as { ok?: boolean; readyToConfirm?: unknown; state?: unknown };
  return (
    candidate?.ok === true &&
    typeof candidate.readyToConfirm === "boolean" &&
    typeof candidate.state === "object" &&
    candidate.state !== null
  );
}

/**
 * Run ONE agent turn: history in, neutral blocks out. Never throws — every
 * failure comes back as `{ ok: false, error }` so a route can answer
 * 200 + ok:false (ADR-11) and a queue worker can decide retryability itself.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const { channel } = input;
  const now = input.now ?? new Date();
  const toolContext: AgentToolContext = input.toolContext ?? { threadId: channel.threadId };

  // ORDERING NEEDS **BOTH** GATES. `messengerOrdersEnabled()` is the global
  // deploy kill switch; `channel.supports.ordering` is the per-surface one.
  // A channel whose threadId is not a MessengerThread psid CANNOT carry order
  // state — update_order resolves its thread by psid, so a customer-GID thread
  // dies at the Prisma lookup — and only the Messenger adapter intercepts the
  // CONFIRM_ORDER_ tap deterministically. Kaya every order-mutating tool is
  // gated on the AND of the two, not on the env flag alone.
  const ordersEnabled = messengerOrdersEnabled() && channel.supports.ordering;
  // Split for prompt caching: `system` is the byte-identical cached prefix;
  // `systemContext` (the current date) rides AFTER the cache breakpoint. These
  // MUST stay two separate strings — concatenating them would move the volatile
  // date inside the cached block and kill the cache hit on every turn.
  // (Two prefix variants now exist — ordering-on and ordering-off — but each is
  // still byte-identical per channel, so the cache still hits.)
  const system = buildStaticSystemPrompt(ordersEnabled, await loadCodFacts());
  const systemContext = buildDynamicContext(now);
  const tools: LlmToolDefinition[] = ordersEnabled
    ? MESSENGER_AGENT_TOOLS
    : MESSENGER_AGENT_TOOLS.filter((tool) => tool.name !== "update_order");

  // Working copy: the loop appends assistant/tool_result turns, and the caller's
  // array must not be mutated (it may be reused for a retry or for logging).
  const messages: LlmMessage[] = [...input.messages];

  const toolsUsed: string[] = [];
  let finalText = "";
  let lastOpenSlots: Extract<GetAvailableDeliverySlotsResult, { available: true }> | null = null;
  let lastProducts: MessengerProduct[] | null = null;
  let lastOrderReady: { orderKey: string; summaryText: string } | null = null;
  let awaitingAddOnChoice = false;

  for (let iteration = 0; iteration < MAX_LLM_ITERATIONS; iteration += 1) {
    const turn = await runLlmTurn({ system, systemContext, messages, tools });
    if (!turn.ok) {
      if (turn.notConfigured || turn.error === MESSENGER_LLM_NOT_CONFIGURED_MESSAGE) {
        console.error(`[agent-core] LLM not configured — dropping turn channel=${channel.kind}`);
        return { ok: false, error: turn.error, notConfigured: true };
      }
      return { ok: false, error: turn.error };
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
      const result = await executeAgentTool(toolUse.name, toolUse.input, now, toolContext);
      toolsUsed.push(toolUse.name);
      console.log(
        `[agent-core] tool ${toolUse.name} channel=${channel.kind} thread=${channel.threadId}`,
      );
      if (toolUse.name === "get_available_slots" && isOpenSlotsResult(result)) {
        lastOpenSlots = result;
      }
      if (toolUse.name === "search_products" && isProductsResult(result) && result.products.length) {
        // purpose="lookup" = the customer is PICKING a named bouquet, not
        // browsing — cards there are noise (live smoke-test feedback).
        const purpose = (toolUse.input as { purpose?: unknown } | null)?.purpose;
        lastProducts = purpose === "lookup" ? null : result.products;
      }
      if (toolUse.name === "get_best_sellers" && isProductsResult(result) && result.products.length) {
        // Curated best sellers always ride the cards.
        lastProducts = result.products;
      }
      if (toolUse.name === "update_order" && isOrderUpdateResult(result)) {
        // The LATEST update decides: a later edit in the same turn can move
        // the state back to collecting, dropping the confirm prompt.
        lastOrderReady =
          result.readyToConfirm && result.orderKey
            ? { orderKey: result.orderKey, summaryText: buildOrderSummaryText(result.state) }
            : null;
        // Add-on upsell: kapag ang susunod na kulang ay ang add-on decision,
        // ang code ang magkakabit ng category choices.
        awaitingAddOnChoice =
          !result.readyToConfirm &&
          Array.isArray(result.missing) &&
          result.missing[0] === "add_on";
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
    // Either the model burned all five iterations on tools, or it answered with
    // nothing but whitespace. Designed failure, not a throw — the caller decides
    // whether that is retryable on its transport.
    return { ok: false, error: AGENT_NO_FINAL_TEXT_ERROR };
  }

  // --- Blocks -------------------------------------------------------------
  //
  // The assistant text is ALWAYS first: every transport leads with it, and the
  // affordance blocks decorate the message that follows.
  const blocks: AgentBlock[] = [];
  const text = (channel.supports.markdown ? finalText : sanitizeMessengerText(finalText)).slice(
    0,
    channel.supports.textLimit,
  );
  blocks.push({ type: "text", text });

  // Defence in depth: a `summary` block is an ORDER-COMMITMENT affordance —
  // it only means something on a channel that ALSO intercepts the following
  // CONFIRM_ORDER_<key> tap in code. On a read-only channel it is a trap (a
  // Confirm button na walang kasunod), so we drop it even if one somehow formed
  // (a stale tool list, a future tool, a hand-rolled channel object).
  // Log the DROP by kind only — never the summary text, never the orderKey.
  let orderReady = lastOrderReady;
  if (orderReady && !channel.supports.ordering) {
    console.warn(
      `[agent-core] dropped block kind=summary — non-ordering channel=${channel.kind} thread=${channel.threadId}`,
    );
    orderReady = null;
  }

  // Suppression rules, carried over from the live Messenger loop:
  //  - a summary WINS over product cards: on Messenger a carousel sent after
  //    the summary dismisses the Confirm quick reply, so the customer loses the
  //    only way to place the order;
  //  - product cards win over slots and add-on choices for the same reason
  //    (the carousel eats the quick replies in the Meta UI).
  const products = orderReady ? null : lastProducts;

  if (orderReady) {
    blocks.push({
      type: "summary",
      text: orderReady.summaryText,
      orderKey: orderReady.orderKey,
    });
  } else if (products) {
    blocks.push({ type: "products", items: products });
  } else if (awaitingAddOnChoice) {
    blocks.push({ type: "choices", options: ADD_ON_CHOICES.map((choice) => ({ ...choice })) });
  } else if (lastOpenSlots) {
    // Full slot list — per-transport caps (Messenger allows 13 quick replies of
    // 20 chars) belong to the adapter, not to the brain.
    blocks.push({
      type: "slots",
      date: lastOpenSlots.date,
      slots: lastOpenSlots.slots.map((slot) => ({ value: slot.value, label: slot.label })),
    });
  }

  return { ok: true, reply: { blocks }, toolsUsed };
}

// --- Re-exports -------------------------------------------------------------
//
// Later channel adapters import EVERYTHING from here so nothing outside the
// Messenger transport ever reaches into messenger-agent.server.ts (that module
// is Meta-specific and will keep its Prisma/Send-API tail).

export {
  buildDynamicContext,
  buildStaticSystemPrompt,
  buildSystemPrompt,
  messengerOrdersEnabled,
  sanitizeMessengerText,
};
export { executeAgentTool, MESSENGER_AGENT_TOOLS };
export { buildOrderSummaryText };
export { MESSENGER_LLM_NOT_CONFIGURED_MESSAGE, runLlmTurn };
export {
  CUSTOMER_ACCOUNT_CAPABILITIES,
  MESSENGER_CAPABILITIES,
  STOREFRONT_CAPABILITIES,
} from "./agent-channel";
export type {
  AgentBlock,
  AgentChannel,
  AgentIdentity,
  AgentReply,
  ChannelCapabilities,
  ChannelKind,
} from "./agent-channel";
export type {
  LlmContentBlock,
  LlmMessage,
  LlmToolDefinition,
  LlmTurnResult,
} from "./messenger-llm.server";
export type { MessengerProduct } from "./messenger-products.server";
export type { GetAvailableDeliverySlotsResult } from "./messenger-agent-tools.server";
