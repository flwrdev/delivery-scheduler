// Channel contract for the FlowerCart conversational agent (extensions phase 1).
//
// WHY THIS FILE EXISTS: the agent brain used to be welded to Messenger — the
// loop returned Messenger primitives (quick replies, generic templates) so the
// only surface that could ever run it was Meta. Customer accounts and the
// storefront need the SAME brain with different affordances, so the brain now
// speaks in neutral BLOCKS and each transport renders them its own way:
//   - Messenger  -> text + quick replies + generic template carousel
//   - customer account / storefront -> markdown text + React cards
//
// This file is deliberately TYPES ONLY: no I/O, no `.server` imports, no npm
// deps. It has to be importable from a route, a service, a test, and (later)
// a UI extension bundle without dragging Prisma or the Anthropic SDK along.
// Kaya walang runtime code dito kundi ang tatlong capability presets.

/** Which surface the conversation is happening on. */
export type ChannelKind = "messenger" | "customer-account" | "storefront";

/**
 * Who we are talking to. Messenger identifies by PSID; a logged-in customer
 * account by their Shopify customer GID; the storefront chat has no identity
 * at all until they log in, kaya may sariling conversation id.
 */
export type AgentIdentity =
  | { type: "psid"; psid: string }
  | { type: "customer"; customerGid: string }
  | { type: "anonymous"; conversationId: string };

/**
 * What the transport can actually render. The brain reads these instead of
 * asking "am I on Messenger?" anywhere in the loop.
 */
export interface ChannelCapabilities {
  /** false on Messenger — asterisks show up literally to the customer. */
  markdown: boolean;
  /** Meta generic template only; the web surfaces draw their own cards. */
  carousel: boolean;
  quickReplies: boolean;
  productCards: boolean;
  /** Hard per-message character cap of the transport (2000 on Messenger). */
  textLimit: number;
  /**
   * May this channel COLLECT and COMMIT an order?
   *
   * Not a styling flag — it is the ordering kill switch per surface, and it is
   * false everywhere except Messenger for two hard reasons:
   *   1. order state is keyed by MessengerThread.psid. A web threadId is a
   *      Shopify customer GID with no MessengerThread row, kaya every
   *      update_order call on the web dies at the Prisma lookup.
   *   2. the deterministic CONFIRM_ORDER_<key> interception (the master-doc
   *      Commitment rule: walang draft order kung walang explicit tap) lives
   *      only in the Messenger adapter. Without it a Confirm affordance on the
   *      web is a button that commits nothing — a trap, not a feature.
   * Merchant decision for v1: the web channels are READ-ONLY SUPPORT.
   */
  ordering: boolean;
}

export interface AgentChannel {
  kind: ChannelKind;
  identity: AgentIdentity;
  supports: ChannelCapabilities;
  /** Stable key for conversation state. psid for messenger; customerGid or conversationId elsewhere. */
  threadId: string;
}

/**
 * The neutral reply vocabulary. Every transport-specific affordance the old
 * Messenger loop produced has exactly one block here:
 *   quick replies for slots   -> "slots"
 *   add-on quick replies      -> "choices"
 *   generic template carousel -> "products"
 *   summary + Confirm button  -> "summary"
 *
 * `products.items` is `unknown[]` on purpose: the real shape is
 * MessengerProduct[] from messenger-products.server, and importing that here
 * would make this file server-only. The adapters narrow it.
 */
export type AgentBlock =
  | { type: "text"; text: string }
  | { type: "products"; items: unknown[] }
  | { type: "slots"; date: string; slots: Array<{ value: string; label: string }> }
  | {
      type: "order";
      name: string;
      financialStatus: string;
      fulfillmentStatus: string;
      deliveryDate: string;
      deliveryTime: string;
      trackingUrl?: string;
    }
  | { type: "choices"; options: Array<{ label: string; payload: string }> }
  | { type: "summary"; text: string; orderKey: string };

export interface AgentReply {
  blocks: AgentBlock[];
}

// --- Capability presets -----------------------------------------------------
//
// Frozen so a caller cannot mutate a shared preset and silently change another
// channel's behavior (the presets are module singletons).

/**
 * Meta Messenger: plain text only, 2000-char cap, native quick replies +
 * carousel. The ONLY channel with ordering — it is the one surface that both
 * owns a MessengerThread row and intercepts the CONFIRM_ORDER_ tap in code.
 */
export const MESSENGER_CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: false,
  carousel: true,
  quickReplies: true,
  productCards: true,
  textLimit: 2000,
  ordering: true,
});

/**
 * Shopify customer account UI extension: React surface, so markdown renders and
 * we draw our own product cards. No Meta carousel, no native quick replies —
 * choices become buttons rendered by the extension. READ-ONLY SUPPORT:
 * ordering:false (v1 merchant decision — ordering stays Messenger-only).
 */
export const CUSTOMER_ACCOUNT_CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: true,
  carousel: false,
  quickReplies: true,
  productCards: true,
  textLimit: 4000,
  ordering: false,
});

/** Storefront chat widget: same web affordances, same read-only posture. */
export const STOREFRONT_CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: true,
  carousel: false,
  quickReplies: true,
  productCards: true,
  textLimit: 4000,
  ordering: false,
});
