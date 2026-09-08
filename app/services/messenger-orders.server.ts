// Phase 6 of the FlowerCart Messenger agent: draft order + invoice.
// Gate: "one order in Shopify, never two."
//
// Two responsibilities live here:
//
//   1. The slot-filling STATE MACHINE (master doc: "the LLM handles language;
//      the code advances state"). Required fields, in this exact order:
//      product/variant → delivery date → time slot → add-on decision
//      (streamline 2026-08-03: recipient/address/phone ay OPTIONAL na — ang
//      checkout ang kokolekta; card message at special instructions optional).
//      Collected state persists on MessengerThread.orderStateJson in Neon —
//      never in the LLM's memory.
//
//   2. The IDEMPOTENT draft-order create. A conversationOrderKey (UUID) is
//      written to Neon BEFORE draftOrderCreate and carried on the draft as
//      BOTH a custom attribute and a tag (mo-key-<uuid>). Check-before-create:
//      search drafts by that tag first; on a timeout, look up by tag again —
//      never blind retry. Cloud Tasks may deliver the same mid twice and may
//      retry after a timeout; both must end with exactly ONE draft order.
//
// The draft carries the EXACT attribute shape the checkout writes ("Delivery
// Date" + "Delivery Time" customAttributes and the frozen [date, slot] tags),
// so when the customer pays the invoice, the existing orders/create webhook
// syncs metafields/tags with zero Messenger-specific code.
//
// Shopify is the order ledger (locked decision #1); orders are DRAFT orders
// completed by the customer through the invoiceUrl (Shopify checkout + the
// store's Xendit plugin). NEVER orderCreate, NEVER mark-as-paid from chat.
//
// Log hygiene: psids, keys, statuses, draft ids, error strings — never
// message text, never recipient name/address/phone.

import crypto from "node:crypto";

import prisma from "../db.server";
import { isIsoDateString } from "../lib/delivery-availability";
import { unauthenticated } from "../shopify.server";
import type { CheckDeliveryCoverageInput, CheckDeliveryCoverageResult } from "./delivery-coverage.server";
import type { GetVariantLiveResult } from "./agent-products.server";

// Frozen attribute keys — the same keys the checkout writes and the
// orders/create sync reads (order-delivery-metafields.server.ts).
const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";
const ORDER_KEY_ATTRIBUTE_KEY = "conversationOrderKey";
const MESSENGER_PSID_ATTRIBUTE_KEY = "messengerPsid";

export const MESSENGER_ORDER_TAG = "messenger";
const ORDER_KEY_TAG_PREFIX = "mo-key-";

// Stock hold while the customer pays (master doc: ~15 minutes).
const RESERVE_INVENTORY_MINUTES = 15;

const MANILA_TZ_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function weekdayOfIso(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return MANILA_TZ_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface MessengerOrderState {
  status: "collecting" | "awaiting_confirm" | "created";
  variantId?: string;
  productTitle?: string;
  pricePhp?: number;
  deliveryDate?: string; // ISO YYYY-MM-DD (from resolve_date)
  timeSlot?: string; // frozen slot value from get_available_slots
  recipientName?: string;
  address?: string;
  addressCity?: string; // coverage-matched city (for the shipping address)
  phone?: string;
  cardMessage?: string;
  specialInstructions?: string;
  // Add-on upsell (2026-08-03): one-time offer pagkatapos makumpleto ang
  // phone — bear/chocolates/balloon bilang pangalawang line item. addOnDecided
  // ang gate: totoo kapag pumili O tumanggi ang customer (isang alok lang).
  addOnDecided?: boolean;
  addOnVariantId?: string;
  addOnTitle?: string;
  addOnPricePhp?: number;
  // Abandoned-order follow-up: ISO timestamp kapag naipadala na ang isang
  // (at nag-iisang) reminder para sa kasalukuyang orderKey.
  followUpSentAt?: string;
  orderKey?: string;
  draftOrderId?: string;
  draftOrderName?: string;
  invoiceUrl?: string;
}

// 2026-08-03 streamline (merchant feedback): ang recipient/address/phone ay
// HINDI na hinihingi sa chat — ang Shopify checkout na mismo ang kokolekta ng
// shipping details ("expected ni customer na magbabayad na lang siya"). Kapag
// kusang ibinigay, sine-save pa rin bilang checkout prefill bonus.
const REQUIRED_FIELDS = [
  "product",
  "delivery_date",
  "time_slot",
  "add_on",
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

function hasField(state: MessengerOrderState, field: RequiredField): boolean {
  switch (field) {
    case "product":
      return Boolean(state.variantId);
    case "delivery_date":
      return Boolean(state.deliveryDate);
    case "time_slot":
      return Boolean(state.timeSlot);
    case "add_on":
      return Boolean(state.addOnDecided);
  }
}

/** The furthest-incomplete-state rule: first missing field in the fixed order. */
export function missingOrderFields(state: MessengerOrderState): RequiredField[] {
  return REQUIRED_FIELDS.filter((field) => !hasField(state, field));
}

export function parseOrderState(orderStateJson: string | null | undefined): MessengerOrderState {
  if (orderStateJson) {
    try {
      const parsed = JSON.parse(orderStateJson) as MessengerOrderState;
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
        // Grandfather clause (2026-08-03): ang mga in-flight na state na
        // ginawa BAGO idagdag ang add-on step ay itinuturing nang desidido —
        // kung hindi, ang Confirm tap ng naka-awaiting_confirm na customer ay
        // biglang magiging "incomplete".
        if (parsed.status !== "collecting" && parsed.addOnDecided === undefined) {
          parsed.addOnDecided = true;
        }
        return parsed;
      }
    } catch {
      // fall through to a fresh state
    }
  }
  return { status: "collecting" };
}

async function saveOrderState(psid: string, state: MessengerOrderState): Promise<void> {
  await prisma.messengerThread.update({
    where: { psid },
    data: {
      orderStateJson: JSON.stringify(state),
      conversationOrderKey: state.orderKey ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// update_order — the state machine's single write entry point
// ---------------------------------------------------------------------------

export interface UpdateOrderStateInput {
  variant_id?: string;
  delivery_date?: string;
  time_slot?: string;
  recipient_name?: string;
  address?: string;
  address_area?: string;
  address_zip?: string;
  phone?: string;
  card_message?: string;
  special_instructions?: string;
  /** Add-on pick: variant id ng bear/chocolates/balloon (validated live). */
  add_on_variant_id?: string;
  /** Add-on decline: "none" (o wala/hindi/no/skip) = tinanggihan ang alok. */
  add_on?: string;
  /** Fields to clear ("baguhin ang petsa" clears only that field). "all" resets. */
  clear?: string[];
}

/**
 * Validation dependencies are injected by the tool layer
 * (agent-tools.server.ts) so this module has no import cycle with
 * it and tests can stub each validator.
 */
export interface OrderValidationDeps {
  getVariant: (variantId: string) => Promise<GetVariantLiveResult>;
  getSlots: (
    input: { date?: string },
    now: Date,
  ) => Promise<
    | { ok: true; date: string; weekday: string; available: true; slots: Array<{ value: string; label: string }> }
    | {
        ok: true;
        date: string;
        weekday: string;
        available: false;
        reason: string;
        nearestAvailableDates: Array<{ date: string; weekday: string }>;
      }
    | { ok: false; error: string }
  >;
  checkCoverage: (input: CheckDeliveryCoverageInput) => CheckDeliveryCoverageResult;
}

export interface OrderFieldError {
  field: string;
  error: string;
  nearestAvailableDates?: Array<{ date: string; weekday: string }>;
}

export type UpdateOrderStateResult =
  | {
      ok: true;
      state: {
        status: MessengerOrderState["status"];
        productTitle?: string;
        pricePhp?: number;
        deliveryDate?: string;
        deliveryWeekday?: string;
        timeSlot?: string;
        recipientName?: string;
        address?: string;
        phone?: string;
        cardMessage?: string;
        specialInstructions?: string;
        addOnTitle?: string;
        addOnPricePhp?: number;
      };
      missing: RequiredField[];
      readyToConfirm: boolean;
      orderKey?: string;
      errors: OrderFieldError[];
      note: string;
    }
  | { ok: false; error: string };

const CLEARABLE: Record<string, (state: MessengerOrderState) => void> = {
  product: (s) => {
    delete s.variantId;
    delete s.productTitle;
    delete s.pricePhp;
  },
  variant: (s) => CLEARABLE.product(s),
  delivery_date: (s) => {
    delete s.deliveryDate;
    // A slot is only valid for its date — clearing the date clears the slot.
    delete s.timeSlot;
  },
  date: (s) => CLEARABLE.delivery_date(s),
  time_slot: (s) => {
    delete s.timeSlot;
  },
  slot: (s) => CLEARABLE.time_slot(s),
  recipient_name: (s) => {
    delete s.recipientName;
  },
  recipient: (s) => CLEARABLE.recipient_name(s),
  address: (s) => {
    delete s.address;
    delete s.addressCity;
  },
  phone: (s) => {
    delete s.phone;
  },
  card_message: (s) => {
    delete s.cardMessage;
  },
  special_instructions: (s) => {
    delete s.specialInstructions;
  },
  add_on: (s) => {
    delete s.addOnDecided;
    delete s.addOnVariantId;
    delete s.addOnTitle;
    delete s.addOnPricePhp;
  },
  addon: (s) => CLEARABLE.add_on(s),
};

function publicState(state: MessengerOrderState): Extract<UpdateOrderStateResult, { ok: true }>["state"] {
  return {
    status: state.status,
    ...(state.productTitle ? { productTitle: state.productTitle } : {}),
    ...(typeof state.pricePhp === "number" ? { pricePhp: state.pricePhp } : {}),
    ...(state.deliveryDate
      ? { deliveryDate: state.deliveryDate, deliveryWeekday: weekdayOfIso(state.deliveryDate) }
      : {}),
    ...(state.timeSlot ? { timeSlot: state.timeSlot } : {}),
    ...(state.recipientName ? { recipientName: state.recipientName } : {}),
    ...(state.address ? { address: state.address } : {}),
    ...(state.phone ? { phone: state.phone } : {}),
    ...(state.cardMessage ? { cardMessage: state.cardMessage } : {}),
    ...(state.specialInstructions ? { specialInstructions: state.specialInstructions } : {}),
    ...(state.addOnTitle ? { addOnTitle: state.addOnTitle } : {}),
    ...(typeof state.addOnPricePhp === "number" ? { addOnPricePhp: state.addOnPricePhp } : {}),
  };
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 7 || digits.length > 13) {
    return null;
  }
  return raw.trim();
}

/**
 * Apply a set of collected/cleared fields to the thread's order state.
 * CODE validates and advances state; the LLM only relays language.
 * Never throws — designed failures only.
 */
export async function updateMessengerOrderState(
  psid: string,
  input: UpdateOrderStateInput,
  deps: OrderValidationDeps,
  now = new Date(),
): Promise<UpdateOrderStateResult> {
  let thread;
  try {
    thread = await prisma.messengerThread.findUnique({ where: { psid } });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not load the thread." };
  }
  if (!thread) {
    return { ok: false, error: "Unknown conversation thread." };
  }

  const state = parseOrderState(thread.orderStateJson);
  const errors: OrderFieldError[] = [];
  let note = "";

  // A created order is immutable from chat — the customer pays the invoice or
  // starts a NEW order (clear: ["all"]).
  const wantsFullReset = (input.clear ?? []).some((f) => f.trim().toLowerCase() === "all");
  if (state.status === "created" && !wantsFullReset) {
    return {
      ok: true,
      state: publicState(state),
      missing: [],
      readyToConfirm: false,
      errors: [
        {
          field: "status",
          error:
            "This order was already created and has a payment link. To order something else, start a NEW order (clear: [\"all\"]); to change this one, a person from The Flowercart will assist.",
        },
      ],
      note: "Order already created.",
    };
  }

  // 1) Clears first (jump-back: clear ONLY that field, keep everything else).
  if (wantsFullReset) {
    const fresh: MessengerOrderState = { status: "collecting" };
    try {
      await saveOrderState(psid, fresh);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not reset the order." };
    }
    return {
      ok: true,
      state: publicState(fresh),
      missing: missingOrderFields(fresh),
      readyToConfirm: false,
      errors: [],
      note: "Order state reset — starting fresh.",
    };
  }
  for (const rawField of input.clear ?? []) {
    const key = rawField.trim().toLowerCase();
    const clearFn = CLEARABLE[key];
    if (clearFn) {
      clearFn(state);
    } else {
      errors.push({ field: key, error: "Unknown field to clear." });
    }
  }

  // 2) Field writes, validated in the canonical order.
  if (typeof input.variant_id === "string" && input.variant_id.trim()) {
    const result = await deps.getVariant(input.variant_id.trim());
    if (!result.ok) {
      errors.push({ field: "product", error: result.error });
    } else if (!result.product.available) {
      errors.push({ field: "product", error: "That bouquet is currently out of stock." });
    } else {
      state.variantId = result.product.variantId;
      state.productTitle = result.product.variantTitle
        ? `${result.product.productTitle} (${result.product.variantTitle})`
        : result.product.productTitle;
      state.pricePhp = result.product.pricePhp;
    }
  }

  if (typeof input.delivery_date === "string" && input.delivery_date.trim()) {
    const date = input.delivery_date.trim();
    if (!isIsoDateString(date)) {
      errors.push({
        field: "delivery_date",
        error: "delivery_date must be an ISO date (YYYY-MM-DD) from resolve_date.",
      });
    } else {
      const slots = await deps.getSlots({ date }, now);
      if (!slots.ok) {
        errors.push({ field: "delivery_date", error: slots.error });
      } else if (!slots.available) {
        errors.push({
          field: "delivery_date",
          error: slots.reason,
          nearestAvailableDates: slots.nearestAvailableDates,
        });
      } else {
        state.deliveryDate = date;
        if (state.timeSlot && !slots.slots.some((slot) => slot.value === state.timeSlot)) {
          delete state.timeSlot;
          note = "The previously chosen time slot is not open on the new date — ask for a slot again.";
        }
      }
    }
  }

  if (typeof input.time_slot === "string" && input.time_slot.trim()) {
    const slotValue = input.time_slot.trim();
    if (!state.deliveryDate) {
      errors.push({ field: "time_slot", error: "Pick a delivery date first — slots are per-date." });
    } else {
      const slots = await deps.getSlots({ date: state.deliveryDate }, now);
      if (!slots.ok) {
        errors.push({ field: "time_slot", error: slots.error });
      } else if (!slots.available) {
        errors.push({
          field: "time_slot",
          error: slots.reason,
          nearestAvailableDates: slots.nearestAvailableDates,
        });
      } else if (!slots.slots.some((slot) => slot.value === slotValue)) {
        errors.push({
          field: "time_slot",
          error: `"${slotValue}" is not an open slot on ${state.deliveryDate}. Open slots: ${slots.slots
            .map((slot) => slot.value)
            .join(", ")}.`,
        });
      } else {
        state.timeSlot = slotValue;
      }
    }
  }

  if (typeof input.recipient_name === "string" && input.recipient_name.trim()) {
    state.recipientName = input.recipient_name.trim();
  }

  if (typeof input.address === "string" && input.address.trim()) {
    const zip = input.address_zip?.trim();
    const area = input.address_area?.trim();
    if (!zip && !area) {
      errors.push({
        field: "address",
        error:
          "Pass address_area (barangay/city) or address_zip together with the address so delivery coverage can be checked.",
      });
    } else {
      const coverage = deps.checkCoverage({
        ...(zip ? { zip } : {}),
        ...(area ? { area } : {}),
      });
      if (!coverage.ok) {
        errors.push({ field: "address", error: coverage.error });
      } else if (!coverage.covered) {
        errors.push({
          field: "address",
          error: `Address not saved — outside the delivery coverage. ${coverage.note}`,
        });
      } else {
        state.address = input.address.trim();
        state.addressCity = coverage.matches[0]?.city;
      }
    }
  }

  if (typeof input.phone === "string" && input.phone.trim()) {
    const phone = normalizePhone(input.phone);
    if (!phone) {
      errors.push({ field: "phone", error: "That does not look like a valid phone number." });
    } else {
      state.phone = phone;
    }
  }

  // Add-on upsell: pumili (validated live, parehong getVariant ng bouquet) o
  // tumanggi ("none") — pareho itong nagma-mark ng addOnDecided para ISANG
  // beses lang ang alok.
  if (typeof input.add_on_variant_id === "string" && input.add_on_variant_id.trim()) {
    const result = await deps.getVariant(input.add_on_variant_id.trim());
    if (!result.ok) {
      errors.push({ field: "add_on", error: result.error });
    } else if (!result.product.available) {
      errors.push({ field: "add_on", error: "That add-on is currently out of stock." });
    } else {
      state.addOnDecided = true;
      state.addOnVariantId = result.product.variantId;
      state.addOnTitle = result.product.variantTitle
        ? `${result.product.productTitle} (${result.product.variantTitle})`
        : result.product.productTitle;
      state.addOnPricePhp = result.product.pricePhp;
    }
  } else if (typeof input.add_on === "string" && input.add_on.trim()) {
    const decision = input.add_on.trim().toLowerCase();
    if (["none", "wala", "hindi", "no", "skip"].includes(decision)) {
      state.addOnDecided = true;
      delete state.addOnVariantId;
      delete state.addOnTitle;
      delete state.addOnPricePhp;
    } else {
      errors.push({
        field: "add_on",
        error: "Pass add_on_variant_id (a validated variant id) to pick an add-on, or add_on: \"none\" to decline.",
      });
    }
  }

  if (typeof input.card_message === "string") {
    const cardMessage = input.card_message.trim();
    if (cardMessage) {
      state.cardMessage = cardMessage;
    }
  }
  if (typeof input.special_instructions === "string") {
    const instructions = input.special_instructions.trim();
    if (instructions) {
      state.specialInstructions = instructions;
    }
  }

  // 3) Advance the machine. All required fields present → awaiting_confirm,
  //    and the idempotency key is minted + persisted NOW (before any Shopify
  //    write can ever happen).
  const missing = missingOrderFields(state);
  if (missing.length === 0) {
    state.status = "awaiting_confirm";
    if (!state.orderKey) {
      state.orderKey = crypto.randomUUID();
    }
  } else {
    state.status = "collecting";
  }

  try {
    await saveOrderState(psid, state);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save the order state." };
  }

  const readyToConfirm = missing.length === 0;
  console.log(
    `[messenger-orders] state updated psid=${psid} status=${state.status} missing=${missing.length} errors=${errors.length}`,
  );

  return {
    ok: true,
    state: publicState(state),
    missing,
    readyToConfirm,
    ...(readyToConfirm && state.orderKey ? { orderKey: state.orderKey } : {}),
    errors,
    note:
      note ||
      (readyToConfirm
        ? "All details collected. A formatted order summary with a Confirm button is sent to the customer AUTOMATICALLY after your reply — keep your text to one short line and do NOT repeat the details."
        : missing[0] === "add_on"
          ? "All main details are in. Offer the add-on ONCE now (bear, chocolates, or balloon — quick reply buttons are attached automatically): one short friendly line, never pushy. If they decline, call update_order with add_on: \"none\"."
          : `Next detail to ask for: ${missing[0]}.`),
  };
}

// ---------------------------------------------------------------------------
// Order summary (deterministic — never composed by the LLM)
// ---------------------------------------------------------------------------

export function buildOrderSummaryText(state: {
  productTitle?: string;
  pricePhp?: number;
  deliveryDate?: string;
  timeSlot?: string;
  recipientName?: string;
  address?: string;
  phone?: string;
  cardMessage?: string;
  specialInstructions?: string;
  addOnTitle?: string;
  addOnPricePhp?: number;
}): string {
  const price =
    typeof state.pricePhp === "number" ? ` — ₱${state.pricePhp.toLocaleString("en-PH")}` : "";
  const dateLabel = state.deliveryDate
    ? `${weekdayOfIso(state.deliveryDate)}, ${state.deliveryDate}`
    : "—";
  const lines = [
    "🧾 ORDER SUMMARY",
    `Bouquet: ${state.productTitle ?? "—"}${price}`,
    ...(state.addOnTitle
      ? [
          `Add-on: ${state.addOnTitle}${
            typeof state.addOnPricePhp === "number"
              ? ` — ₱${state.addOnPricePhp.toLocaleString("en-PH")}`
              : ""
          }`,
        ]
      : []),
    `Delivery: ${dateLabel} • ${state.timeSlot ?? "—"}`,
    // Streamline 2026-08-03: shipping details ay sa checkout na pinupunan —
    // lumalabas lang dito kapag kusang ibinigay sa chat.
    ...(state.recipientName ? [`Recipient: ${state.recipientName}`] : []),
    ...(state.address ? [`Address: ${state.address}`] : []),
    ...(state.phone ? [`Phone: ${state.phone}`] : []),
    ...(state.cardMessage ? [`Card message: ${state.cardMessage}`] : []),
  ];
  if (state.specialInstructions) {
    lines.push(`Special instructions: ${state.specialInstructions}`);
  }
  lines.push(
    "",
    "Kung tama po lahat, i-tap ang Confirm para makuha ang secure na payment link — doon niyo na ilalagay ang delivery address. 💐",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Abandoned-order follow-up claim (2026-08-03)
// ---------------------------------------------------------------------------
//
// Mark-BEFORE-send: ang followUpSentAt ay isinusulat BAGO ang Messenger send,
// kaya kahit mag-retry ang Cloud Tasks o ma-deliver nang doble ang task, ISANG
// reminder lang kailanman ang maipapadala per orderKey. Kapag pumalya ang send
// pagkatapos ng claim, hindi na inuulit — mas pipiliin ang zero-duplicate
// kaysa guaranteed delivery para sa isang nudge.

export type ClaimOrderFollowUpResult =
  | { ok: true; state: MessengerOrderState }
  | {
      ok: false;
      reason: "not_found" | "not_awaiting" | "stale_key" | "already_sent" | "error";
      error?: string;
    };

export async function claimOrderFollowUp(
  psid: string,
  orderKey: string,
): Promise<ClaimOrderFollowUpResult> {
  let thread;
  try {
    thread = await prisma.messengerThread.findUnique({ where: { psid } });
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      error: error instanceof Error ? error.message : "Could not load the thread.",
    };
  }
  if (!thread) {
    return { ok: false, reason: "not_found" };
  }

  const state = parseOrderState(thread.orderStateJson);
  if (state.status !== "awaiting_confirm") {
    // Na-confirm na, na-reset, o hindi kailanman umabot — walang ipapaalala.
    return { ok: false, reason: "not_awaiting" };
  }
  if (!state.orderKey || state.orderKey !== orderKey.trim()) {
    return { ok: false, reason: "stale_key" };
  }
  if (state.followUpSentAt) {
    return { ok: false, reason: "already_sent" };
  }

  state.followUpSentAt = new Date().toISOString();
  try {
    await saveOrderState(psid, state);
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      error: error instanceof Error ? error.message : "Could not save the follow-up claim.",
    };
  }
  return { ok: true, state };
}

// ---------------------------------------------------------------------------
// Idempotent draft-order create (the CONFIRM tap path)
// ---------------------------------------------------------------------------

export type ConfirmMessengerOrderResult =
  | { ok: true; invoiceUrl: string; draftOrderName: string; alreadyCreated: boolean }
  | { ok: false; code: "not_found" | "stale_key" | "incomplete" | "failed"; error: string }
  | { ok: false; code: "transient"; error: string };

interface AdminGraphqlClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation MessengerDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_BY_KEY_QUERY = `#graphql
  query MessengerDraftOrderByKey($query: String!) {
    draftOrders(first: 1, query: $query) {
      nodes {
        id
        name
        invoiceUrl
      }
    }
  }
`;

interface DraftOrderNode {
  id?: string;
  name?: string;
  invoiceUrl?: string | null;
}

async function getAdminClient(): Promise<
  { ok: true; admin: AdminGraphqlClient } | { ok: false; error: string }
> {
  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return { ok: false, error: "MESSENGER_SHOP is not configured on this environment." };
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { ok: true, admin: admin as unknown as AdminGraphqlClient };
  } catch (error) {
    return {
      ok: false,
      error: `Shopify admin client unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

export function orderKeyTag(orderKey: string): string {
  // Shopify tags max out at 40 chars: "mo-key-" (7) + full UUID (36) = 43 ay
  // tinanggihan ng draftOrderCreate (live 2026-08-02). Dashes stripped = 39.
  return `${ORDER_KEY_TAG_PREFIX}${orderKey.replace(/-/g, "")}`;
}

/** Look up an existing draft order by its idempotency-key tag. Never throws. */
async function findDraftOrderByKey(
  admin: AdminGraphqlClient,
  orderKey: string,
): Promise<{ ok: true; node: DraftOrderNode | null } | { ok: false; error: string }> {
  try {
    const response = await admin.graphql(DRAFT_ORDER_BY_KEY_QUERY, {
      variables: { query: `tag:'${orderKeyTag(orderKey)}'` },
    });
    const body = (await response.json()) as {
      data?: { draftOrders?: { nodes?: DraftOrderNode[] } };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length) {
      return {
        ok: false,
        error: body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`,
      };
    }
    return { ok: true, node: body.data?.draftOrders?.nodes?.[0] ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Draft order lookup failed." };
  }
}

function splitName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] ?? fullName.trim();
  const lastName = parts.slice(1).join(" ");
  return lastName ? { firstName, lastName } : { firstName };
}

function buildDraftOrderInput(psid: string, state: MessengerOrderState, now: Date) {
  const orderKey = state.orderKey ?? "";
  const noteParts: string[] = ["Messenger order (FlowerBot)."];
  if (state.cardMessage) {
    noteParts.push(`Card message: ${state.cardMessage}`);
  }
  if (state.specialInstructions) {
    noteParts.push(`Special instructions: ${state.specialInstructions}`);
  }
  return {
    lineItems: [
      { variantId: state.variantId, quantity: 1 },
      // Add-on upsell (2026-08-03): pangalawang line item kapag pumili ang
      // customer (bear/chocolates/balloon) — validated live bago naka-save.
      ...(state.addOnVariantId ? [{ variantId: state.addOnVariantId, quantity: 1 }] : []),
    ],
    customAttributes: [
      // EXACT checkout shape — the orders/create sync reads these keys.
      { key: DELIVERY_DATE_ATTRIBUTE_KEY, value: state.deliveryDate },
      { key: DELIVERY_TIME_ATTRIBUTE_KEY, value: state.timeSlot },
      { key: ORDER_KEY_ATTRIBUTE_KEY, value: orderKey },
      // DraftOrderInput has no sourceUrl — the psid attribute is the thread
      // pointer for the phase-8 dashboard instead.
      { key: MESSENGER_PSID_ATTRIBUTE_KEY, value: psid },
    ],
    // Frozen tag shape [date, slot] (buildDeliveryTags) + the messenger tag
    // (locked decision #5) + the idempotency-key tag.
    tags: [MESSENGER_ORDER_TAG, orderKeyTag(orderKey), state.deliveryDate, state.timeSlot],
    note: noteParts.join("\n"),
    sourceName: "messenger",
    reserveInventoryUntil: new Date(
      now.getTime() + RESERVE_INVENTORY_MINUTES * 60 * 1000,
    ).toISOString(),
    // Streamline 2026-08-03: ang shipping ay kadalasang sa CHECKOUT na
    // pinupunan — isinasama lang ang address dito kapag kusang ibinigay sa
    // chat (prefill bonus).
    ...(state.address
      ? {
          shippingAddress: {
            ...splitName(state.recipientName ?? ""),
            address1: state.address,
            ...(state.addressCity ? { city: state.addressCity } : {}),
            ...(state.phone ? { phone: state.phone } : {}),
            countryCode: "PH",
          },
        }
      : {}),
  };
}

/**
 * The deterministic CONFIRM path: create the draft order exactly once for
 * this conversationOrderKey and return its invoice link. Safe to call any
 * number of times (duplicate mid delivery, Cloud Tasks retries). Never throws.
 */
export async function confirmMessengerOrder(
  psid: string,
  orderKey: string,
  now = new Date(),
): Promise<ConfirmMessengerOrderResult> {
  let thread;
  try {
    thread = await prisma.messengerThread.findUnique({ where: { psid } });
  } catch (error) {
    return {
      ok: false,
      code: "transient",
      error: error instanceof Error ? error.message : "Could not load the thread.",
    };
  }
  if (!thread) {
    return { ok: false, code: "not_found", error: "Unknown conversation thread." };
  }

  const state = parseOrderState(thread.orderStateJson);
  if (!state.orderKey || state.orderKey !== orderKey.trim()) {
    // A stale Confirm tap from an older summary (the order was edited or
    // reset since). Never create from a stale key.
    return { ok: false, code: "stale_key", error: "Confirm tap does not match the current order." };
  }

  // Duplicate delivery of the same confirm after success: answer from state,
  // zero Shopify calls.
  if (state.status === "created" && state.invoiceUrl) {
    console.log(`[messenger-orders] confirm replay key=${state.orderKey} — already created`);
    return {
      ok: true,
      invoiceUrl: state.invoiceUrl,
      draftOrderName: state.draftOrderName ?? "",
      alreadyCreated: true,
    };
  }

  const missing = missingOrderFields(state);
  if (missing.length > 0 || state.status !== "awaiting_confirm") {
    return {
      ok: false,
      code: "incomplete",
      error: `Order details are incomplete (missing: ${missing.join(", ") || "state"}).`,
    };
  }

  const client = await getAdminClient();
  if (!client.ok) {
    // Config/session problems can heal (token refresh) — let the queue retry.
    return { ok: false, code: "transient", error: client.error };
  }

  const adopt = async (node: DraftOrderNode): Promise<ConfirmMessengerOrderResult> => {
    state.status = "created";
    state.draftOrderId = node.id;
    state.draftOrderName = node.name ?? "";
    state.invoiceUrl = node.invoiceUrl ?? "";
    try {
      await saveOrderState(psid, state);
    } catch (error) {
      console.warn(
        `[messenger-orders] state save failed after create key=${orderKey}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
      // The draft exists — the tag lookup makes any replay converge on it.
    }
    return {
      ok: true,
      invoiceUrl: state.invoiceUrl ?? "",
      draftOrderName: state.draftOrderName ?? "",
      alreadyCreated: false,
    };
  };

  // Check-before-create: a prior attempt may have created the draft and then
  // timed out before we recorded it.
  const existing = await findDraftOrderByKey(client.admin, orderKey);
  if (existing.ok && existing.node?.id) {
    console.log(`[messenger-orders] found existing draft for key=${orderKey} — adopting, no create`);
    return adopt(existing.node);
  }
  if (!existing.ok) {
    // Cannot prove absence — creating now could duplicate. Retry later.
    return { ok: false, code: "transient", error: `Pre-create lookup failed: ${existing.error}` };
  }

  try {
    const response = await client.admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
      variables: { input: buildDraftOrderInput(psid, state, now) },
    });
    const body = (await response.json()) as {
      data?: {
        draftOrderCreate?: {
          draftOrder?: DraftOrderNode | null;
          userErrors?: Array<{ field?: string[]; message?: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    const userErrors = body.data?.draftOrderCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      // Shopify validated and refused — a retry with the same input cannot
      // help, and nothing was created.
      const detail = userErrors.map((e) => e.message).join("; ");
      console.warn(`[messenger-orders] draftOrderCreate userErrors key=${orderKey}: ${detail}`);
      return { ok: false, code: "failed", error: detail };
    }

    const node = body.data?.draftOrderCreate?.draftOrder;
    if (!response.ok || body.errors?.length || !node?.id) {
      // Ambiguous outcome (throttle, 5xx, malformed body): the draft MAY
      // exist. Look it up by tag — never blind retry.
      const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
      const lookup = await findDraftOrderByKey(client.admin, orderKey);
      if (lookup.ok && lookup.node?.id) {
        console.log(`[messenger-orders] create ambiguous but draft found key=${orderKey} — adopting`);
        return adopt(lookup.node);
      }
      return { ok: false, code: "transient", error: `draftOrderCreate failed: ${detail}` };
    }

    console.log(`[messenger-orders] draft created key=${orderKey} id=${node.id}`);
    return adopt(node);
  } catch (error) {
    // Timeout / network failure: the create may or may not have landed.
    // Post-timeout lookup by tag; if still absent, report transient so the
    // Cloud Tasks retry re-runs the whole check-before-create sequence.
    const detail = error instanceof Error ? error.message : "draftOrderCreate threw.";
    console.warn(`[messenger-orders] draftOrderCreate threw key=${orderKey}: ${detail}`);
    const lookup = await findDraftOrderByKey(client.admin, orderKey);
    if (lookup.ok && lookup.node?.id) {
      console.log(`[messenger-orders] post-timeout lookup found draft key=${orderKey} — adopting`);
      return adopt(lookup.node);
    }
    return { ok: false, code: "transient", error: detail };
  }
}

// ---------------------------------------------------------------------------
// Order-status lookup by email (2026-08-03) — READ-ONLY
// ---------------------------------------------------------------------------
//
// Merchant decision: email lang ang validation (para hindi na kailangang
// hanapin ng customer ang order number sa email notification). Seguridad:
// LIMITADO ang ibinubunyag — status at delivery info lang, KAILANMAN walang
// address o buong contact details; ang mismong query-by-email ang verification
// (walang match = walang sasabihin, ni hindi kinukumpirma ang existence).

export interface MessengerOrderStatus {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  deliveryDate: string;
  deliveryTime: string;
}

export type LookupOrdersByEmailResult =
  | { ok: true; orders: MessengerOrderStatus[]; note: string }
  | { ok: false; error: string };

const ORDERS_BY_EMAIL_QUERY = `#graphql
  query MessengerOrdersByEmail($query: String!) {
    orders(first: 3, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        customAttributes {
          key
          value
        }
      }
    }
  }
`;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function lookupOrdersByEmail(email: string): Promise<LookupOrdersByEmailResult> {
  const cleaned = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(cleaned)) {
    return { ok: false, error: "That does not look like a valid email address." };
  }

  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error };
  }

  try {
    const response = await client.admin.graphql(ORDERS_BY_EMAIL_QUERY, {
      // Ang quotes sa search value ay nililinis — walang query injection sa
      // Shopify search syntax.
      variables: { query: `email:"${cleaned.replace(/["\\]/g, "")}"` },
    });
    const body = (await response.json()) as {
      data?: {
        orders?: {
          nodes?: Array<{
            name?: string;
            createdAt?: string;
            displayFinancialStatus?: string | null;
            displayFulfillmentStatus?: string | null;
            customAttributes?: Array<{ key?: string; value?: string | null }> | null;
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length) {
      return {
        ok: false,
        error: body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`,
      };
    }

    const attr = (
      attrs: Array<{ key?: string; value?: string | null }> | null | undefined,
      key: string,
    ) => attrs?.find((a) => a.key === key)?.value ?? "";

    const orders = (body.data?.orders?.nodes ?? []).map(
      (node): MessengerOrderStatus => ({
        name: node.name ?? "",
        createdAt: node.createdAt ?? "",
        financialStatus: node.displayFinancialStatus ?? "",
        fulfillmentStatus: node.displayFulfillmentStatus ?? "",
        deliveryDate: attr(node.customAttributes, DELIVERY_DATE_ATTRIBUTE_KEY),
        deliveryTime: attr(node.customAttributes, DELIVERY_TIME_ATTRIBUTE_KEY),
      }),
    );

    console.log(`[messenger-orders] email lookup returned ${orders.length} order(s)`);
    return {
      ok: true,
      orders,
      note: orders.length
        ? "Share ONLY the status and delivery schedule — never an address or payment details."
        : "No orders found for that email. Do not confirm or deny whether the email exists in the system.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Order lookup failed.",
    };
  }
}
