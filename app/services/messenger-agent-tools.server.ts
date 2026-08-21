// Agent tools for the FlowerCart Messenger agent (phase 4).
//
// Two tools, per the master doc's phase-4 gate ("correct resolved date,
// correct available slots"):
//   - resolve_date: the LLM extracts the date PHRASE into a structured input;
//     THIS code does the arithmetic, pinned to Asia/Manila. The LLM never
//     computes an ISO date itself.
//   - get_available_slots: a DIRECT function call into the existing scheduler
//     engine (same rules/validation the storefront cart picker uses) — the
//     whole reason the agent lives in this repo. No HTTP boundary.
//
// Both quotable per the architecture doc: their results are the ONLY source
// the agent may quote for dates and availability.

import {
  getAvailableSlots,
  isIsoDateString,
  validateDeliveryDate,
} from "../lib/delivery-availability";
import type { DeliveryScheduleRules } from "../lib/delivery-availability";
import { getScheduleRulesWithBookedCounts } from "./schedule-rules.server";
import { checkDeliveryCoverage } from "./messenger-coverage.server";
import type { CheckDeliveryCoverageInput } from "./messenger-coverage.server";
import { getBestSellers, getVariantLive, searchShopProducts } from "./messenger-products.server";
import type { SearchShopProductsInput } from "./messenger-products.server";
import { updateMessengerOrderState } from "./messenger-orders.server";
import type { UpdateOrderStateInput } from "./messenger-orders.server";
import {
  clearLookupFailures,
  isLookupLocked,
  lookupOrderByNameAndZip,
  lookupOrdersByCustomerId,
  recordLookupFailure,
} from "./order-lookup.server";
import type { LlmToolDefinition } from "./messenger-llm.server";
import { unauthenticated } from "../shopify.server";

const MANILA_TZ = "Asia/Manila";

const WEEKDAYS_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAYS_FIL: Record<(typeof WEEKDAYS_EN)[number], string> = {
  Sunday: "Linggo",
  Monday: "Lunes",
  Tuesday: "Martes",
  Wednesday: "Miyerkules",
  Thursday: "Huwebes",
  Friday: "Biyernes",
  Saturday: "Sabado",
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Today's date (YYYY-MM-DD) as seen from Asia/Manila — never bare new Date() math. */
export function getManilaTodayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Human-readable Manila datetime for the system prompt. */
export function getManilaNowLabel(now = new Date()): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: MANILA_TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
}

function addDaysIso(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return utc.toISOString().slice(0, 10);
}

function weekdayOfIso(dateStr: string): (typeof WEEKDAYS_EN)[number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return WEEKDAYS_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export interface ResolveDeliveryDateInput {
  base?: "today" | "tomorrow" | "day_after_tomorrow" | "weekday" | "explicit" | string;
  weekday?: string;
  month?: number;
  day?: number;
  year?: number;
}

export type ResolveDeliveryDateResult =
  | { ok: true; isoDate: string; weekday: string; weekdayFil: string }
  | { ok: false; error: string };

export function resolveDeliveryDate(
  input: ResolveDeliveryDateInput,
  now = new Date(),
): ResolveDeliveryDateResult {
  const today = getManilaTodayIso(now);

  let isoDate: string;
  switch (input.base) {
    case "today":
      isoDate = today;
      break;
    case "tomorrow":
      isoDate = addDaysIso(today, 1);
      break;
    case "day_after_tomorrow":
      isoDate = addDaysIso(today, 2);
      break;
    case "weekday": {
      const target = WEEKDAY_INDEX[(input.weekday ?? "").toLowerCase()];
      if (target === undefined) {
        return { ok: false, error: "weekday is required and must be a day name in English." };
      }
      const todayIndex = WEEKDAY_INDEX[weekdayOfIso(today).toLowerCase()];
      // Strictly the NEXT occurrence (1-7 days ahead) — "sa Sabado" said on a
      // Saturday means next week; the weekday echo lets the customer correct us.
      const ahead = ((target - todayIndex + 7 - 1) % 7) + 1;
      isoDate = addDaysIso(today, ahead);
      break;
    }
    case "explicit": {
      const { month, day } = input;
      if (!month || !day) {
        return { ok: false, error: "month and day are required for an explicit date." };
      }
      const yearCandidates = input.year
        ? [input.year]
        : [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1];
      let resolved: string | null = null;
      for (const year of yearCandidates) {
        const candidate: Date = new Date(Date.UTC(year, month - 1, day));
        const iso = candidate.toISOString().slice(0, 10);
        // Reject rollovers like Feb 30 -> Mar 2.
        if (
          candidate.getUTCFullYear() !== year ||
          candidate.getUTCMonth() !== month - 1 ||
          candidate.getUTCDate() !== day
        ) {
          return { ok: false, error: "That calendar date does not exist." };
        }
        if (input.year || iso >= today) {
          resolved = iso;
          break;
        }
      }
      if (!resolved) {
        return { ok: false, error: "Could not resolve that date." };
      }
      isoDate = resolved;
      break;
    }
    default:
      return { ok: false, error: "base must be one of today|tomorrow|day_after_tomorrow|weekday|explicit." };
  }

  const weekday = weekdayOfIso(isoDate);
  return { ok: true, isoDate, weekday, weekdayFil: WEEKDAYS_FIL[weekday] };
}

export interface GetAvailableDeliverySlotsInput {
  date?: string;
}

export type GetAvailableDeliverySlotsResult =
  | {
      ok: true;
      date: string;
      weekday: string;
      available: true;
      slots: Array<{ value: string; label: string }>;
    }
  | {
      ok: true;
      date: string;
      weekday: string;
      available: false;
      reason: string;
      nearestAvailableDates: Array<{ date: string; weekday: string }>;
    }
  | { ok: false; error: string };

async function loadRulesForShop(): Promise<
  { ok: true; rules: DeliveryScheduleRules } | { ok: false; error: string }
> {
  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return { ok: false, error: "MESSENGER_SHOP is not configured on this environment." };
  }

  // Live booked counts need an Admin client from the offline session; if that
  // fails we still answer from the configured rules (blocked dates/slots,
  // cutoff, window) rather than going silent.
  let admin: unknown;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.warn(
      `[messenger-agent] admin client unavailable, answering without live counts: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    admin = undefined;
  }

  try {
    const rules = await getScheduleRulesWithBookedCounts(
      shop,
      admin as Parameters<typeof getScheduleRulesWithBookedCounts>[1],
    );
    return { ok: true, rules };
  } catch (error) {
    return {
      ok: false,
      error: `Could not load the delivery schedule: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    };
  }
}

function nearestAvailableDates(
  rules: DeliveryScheduleRules,
  now: Date,
  limit = 3,
): Array<{ date: string; weekday: string }> {
  const today = getManilaTodayIso(now);
  const results: Array<{ date: string; weekday: string }> = [];
  for (let offset = 0; offset < 45 && results.length < limit; offset += 1) {
    const candidate = addDaysIso(today, offset);
    const validation = validateDeliveryDate(rules, candidate, now);
    if (validation.ok && getAvailableSlots(rules, candidate, now).length > 0) {
      results.push({ date: candidate, weekday: weekdayOfIso(candidate) });
    }
  }
  return results;
}

export async function getAvailableDeliverySlots(
  input: GetAvailableDeliverySlotsInput,
  now = new Date(),
): Promise<GetAvailableDeliverySlotsResult> {
  const date = input.date?.trim() ?? "";
  if (!isIsoDateString(date)) {
    return { ok: false, error: "date must be an ISO date (YYYY-MM-DD) from resolve_date." };
  }

  const loaded = await loadRulesForShop();
  if (!loaded.ok) {
    return { ok: false, error: loaded.error };
  }

  const weekday = weekdayOfIso(date);
  const validation = validateDeliveryDate(loaded.rules, date, now);
  const slots = validation.ok ? getAvailableSlots(loaded.rules, date, now) : [];

  if (!validation.ok || slots.length === 0) {
    return {
      ok: true,
      date,
      weekday,
      available: false,
      reason: validation.ok
        ? "All time slots on that date are fully booked or blocked."
        : validation.message,
      nearestAvailableDates: nearestAvailableDates(loaded.rules, now),
    };
  }

  return {
    ok: true,
    date,
    weekday,
    available: true,
    slots: slots.map((slot) => ({ value: slot.value, label: slot.display })),
  };
}

// --- Tool registry (schemas handed to the LLM verbatim) ---

export const MESSENGER_AGENT_TOOLS: LlmToolDefinition[] = [
  {
    name: "resolve_date",
    description:
      "Resolve a customer's delivery-date phrase into an exact calendar date in Asia/Manila. " +
      "Extract the PHRASE STRUCTURE only — never compute the date yourself. " +
      "Examples: 'bukas' -> base=tomorrow; 'sa makalawa' -> base=day_after_tomorrow; " +
      "'sa Sabado' -> base=weekday, weekday=saturday; 'Dec 24' -> base=explicit, month=12, day=24.",
    input_schema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          enum: ["today", "tomorrow", "day_after_tomorrow", "weekday", "explicit"],
          description: "The kind of date phrase the customer used.",
        },
        weekday: {
          type: "string",
          enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          description: "Required when base=weekday (English day name).",
        },
        month: { type: "integer", description: "1-12; required when base=explicit." },
        day: { type: "integer", description: "1-31; required when base=explicit." },
        year: { type: "integer", description: "Only when the customer said a year explicitly." },
      },
      required: ["base"],
    },
  },
  {
    name: "get_available_slots",
    description:
      "Get the open delivery time slots for an exact ISO date (YYYY-MM-DD, from resolve_date). " +
      "Slot availability is per-date, so call this only AFTER the date is resolved. " +
      "If the date is closed or full, the result includes the nearest available dates to offer instead.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO date YYYY-MM-DD (use resolve_date first)." },
      },
      required: ["date"],
    },
  },
  {
    name: "check_delivery_coverage",
    description:
      "Check whether a place is inside The Flowercart's Metro Manila delivery coverage, " +
      "using the shop's own zip/barangay list. Call this when the customer asks kung saan " +
      "kayo nagde-deliver, kung covered ang lugar nila, o nagbanggit ng lugar/zip para sa delivery. " +
      "Pass the zip code if given, else the barangay/area/city name.",
    input_schema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "Philippine zip code, e.g. 1300." },
        area: { type: "string", description: "Barangay, area, subdivision, or city name." },
      },
      required: [],
    },
  },
  {
    name: "search_products",
    description:
      "Search The Flowercart's LIVE Shopify catalog (bouquets, arrangements, add-ons) with current " +
      "prices. Call this when the customer asks about products, prices, recommendations, or a budget " +
      "(e.g. 'may below 1000 ba kayo?' -> max_price=1000). For 'pinakamura / cheapest' pass " +
      "sort='price_asc'; for 'pinakamahal / most expensive' pass sort='price_desc' — only then may you " +
      "state a cheapest/most-expensive superlative (never eyeball it from an unsorted result). A product " +
      "carousel with photos is sent to the customer AUTOMATICALLY after your reply — keep your text " +
      "short and do NOT list the products or prices yourself.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keyword from the product title, e.g. 'rose', 'sunflower'.",
        },
        min_price: { type: "number", description: "Optional minimum price in PHP." },
        max_price: { type: "number", description: "Optional maximum price in PHP." },
        sort: {
          type: "string",
          enum: ["price_asc", "price_desc"],
          description:
            "price_asc = cheapest first (for 'pinakamura'), price_desc = most expensive first " +
            "(for 'pinakamahal'). Omit for a normal browse.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter to bouquets that have ALL these tags. Colors: pink, red, white, blue, yellow, purple, orange. " +
            "Types: roses, carnation, lilies, sunflower, daisies, tulips. Compound: 'red rose', 'white rose', " +
            "'pink carnation', 'blue hydrangea', etc. e.g. 'puro white' -> [\"white\"]; 'red roses' -> [\"red rose\"].",
        },
        exclude_tags: {
          type: "array",
          items: { type: "string" },
          description: "Exclude bouquets that have any of these tags, e.g. 'ayaw ko ng roses' -> [\"roses\"].",
        },
        addons: {
          type: "boolean",
          description:
            "true = search ONLY add-ons (teddy bear, chocolates, balloon) for the add-on upsell. " +
            "Omit for a normal bouquet search (add-ons are excluded by default).",
        },
        purpose: {
          type: "string",
          enum: ["browse", "lookup"],
          description:
            "browse (default) = the customer is exploring, a carousel will be sent. " +
            "lookup = the customer is PICKING a specific bouquet by name — no carousel is sent.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_best_sellers",
    description:
      "Return The Flowercart's curated BEST SELLERS (a fixed merchant-picked set), with live prices. " +
      "Call this when the customer asks for best sellers / paborito / popular / 'ano maganda' / " +
      "'ano madalas bilhin'. A carousel is sent to the customer AUTOMATICALLY after your reply — keep " +
      "your text to one short line and do NOT list the names or prices. NEVER claim a plain " +
      "search_products result is a best seller; only this tool's result is.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_product_details",
    description:
      "Re-validate a product variant LIVE (current price and availability). ALWAYS call this when a " +
      "customer message starts with [TAP] PRODUCT_<variantId> — the tapped card may be days old, so " +
      "never quote the card's price without re-checking here first.",
    input_schema: {
      type: "object",
      properties: {
        variant_id: {
          type: "string",
          description: "The gid://shopify/ProductVariant/... id from the tapped card's payload.",
        },
      },
      required: ["variant_id"],
    },
  },
  {
    name: "update_order",
    description:
      "Save order details the customer just gave (phase 6 ordering). Call this EVERY time the " +
      "customer provides or changes an order detail — the tool validates and PERSISTS it; anything " +
      "not saved here is lost. Required details are collected in this order: product (variant_id) → " +
      "delivery_date (ISO, from resolve_date) → time_slot (an OPEN slot value for that date) → " +
      "add-on decision (add_on_variant_id to pick a bear/chocolates/balloon add-on, or add_on: 'none' " +
      "to decline — the offer is made exactly once). recipient_name/address/phone are OPTIONAL — the " +
      "checkout collects shipping; save them only if the customer volunteers them (address still needs " +
      "address_area or address_zip for the coverage check). card_message and special_instructions are optional. To change a detail ('baguhin ang petsa'), " +
      "pass clear=[\"delivery_date\"] plus the new value if given — never restart the order. " +
      "The result lists what is still missing; when readyToConfirm=true a formatted summary with a " +
      "Confirm button is sent to the customer automatically after your reply.",
    input_schema: {
      type: "object",
      properties: {
        variant_id: {
          type: "string",
          description: "gid://shopify/ProductVariant/... of the chosen bouquet (from search_products / get_product_details / a [TAP] PRODUCT_ payload).",
        },
        delivery_date: {
          type: "string",
          description: "ISO date YYYY-MM-DD from resolve_date. Never compute this yourself.",
        },
        time_slot: {
          type: "string",
          description: "Exact slot value from get_available_slots or a [TAP] SLOT_ payload (e.g. 9AM-12PM).",
        },
        recipient_name: { type: "string", description: "Full name of the recipient." },
        address: { type: "string", description: "Complete delivery address as the customer typed it." },
        address_area: {
          type: "string",
          description: "Barangay/area/city of the address — required (or address_zip) for the coverage check.",
        },
        address_zip: { type: "string", description: "Zip code of the address, if the customer gave one." },
        phone: { type: "string", description: "Recipient's contact number." },
        card_message: { type: "string", description: "Optional card message." },
        special_instructions: {
          type: "string",
          description: "Optional rider/delivery instructions (e.g. surprise delivery, 'do not call recipient').",
        },
        add_on_variant_id: {
          type: "string",
          description:
            "gid://shopify/ProductVariant/... of the chosen ADD-ON (bear/chocolates/balloon) from search_products / get_product_details.",
        },
        add_on: {
          type: "string",
          description: "Pass \"none\" when the customer declines the add-on offer.",
        },
        clear: {
          type: "array",
          items: { type: "string" },
          description:
            "Fields to clear before applying new values: product, delivery_date, time_slot, recipient_name, address, phone, card_message, special_instructions, add_on — or \"all\" to start a new order.",
        },
      },
      required: [],
    },
  },
  {
    name: "lookup_order",
    description:
      "Look up a customer's EXISTING Shopify order by their ORDER NUMBER + the ZIP CODE used at " +
      "checkout (works for website orders too, not just Messenger orders). Both are on the order " +
      "confirmation email — ask for both before calling. Returns order number, payment status, " +
      "fulfillment status, delivery date/time, and a tracking link/number if the order has shipped. " +
      "NEVER reveal addresses, phone numbers, or payment details from an order — status, delivery " +
      "schedule, and tracking only.",
    input_schema: {
      type: "object",
      properties: {
        order_number: {
          type: "string",
          description:
            "The order number from their confirmation email (e.g. '#1234' or '1234' — either form is fine).",
        },
        zip: {
          type: "string",
          description: "The zip/postal code they used at checkout, from the same confirmation email.",
        },
      },
      required: ["order_number", "zip"],
    },
  },
];

/**
 * The AUTHENTICATED replacement for `lookup_order` (extensions phase 3).
 *
 * WHY it is not in MESSENGER_AGENT_TOOLS: it only makes sense on a surface where
 * Shopify has ALREADY proven who the customer is (the customer-account session
 * token's `sub` claim). It is offered INSTEAD of `lookup_order` there — an
 * authenticated customer must never be asked to recite an order number and a
 * zip, and must never be lockout-able, kaya walang anti-guessing counter dito:
 * there is nothing to guess. The tool list swap lives in agent-core.server.ts.
 *
 * No input parameters on purpose: the customer GID comes from the session, from
 * AgentToolContext — NEVER from the LLM, which could otherwise hand us someone
 * else's id.
 */
export const LOOKUP_MY_ORDERS_TOOL: LlmToolDefinition = {
  name: "lookup_my_orders",
  description:
    "Look up THIS signed-in customer's own recent orders. Takes NO input — the customer is already " +
    "logged in, so never ask them for an order number, a zip code, or an email address; just call " +
    "this. Returns each order's number, payment status, fulfillment status, delivery date/time, and " +
    "a tracking link/number if the order has shipped. NEVER reveal addresses, phone numbers, or " +
    "payment details from an order — status, delivery schedule, and tracking only.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export interface AgentToolContext {
  /** The Messenger thread the turn belongs to (needed by stateful tools). */
  psid?: string;
  /**
   * Channel-agnostic conversation key (extensions phase 1): psid on Messenger,
   * customer GID or an anonymous conversation id on the web surfaces. Added
   * alongside `psid` instead of replacing it so the live Messenger caller keeps
   * working byte-for-byte; `threadId` wins when both are present.
   */
  threadId?: string;
  /**
   * The VERIFIED Shopify customer GID of the turn, set by agent-core only when
   * `channel.identity.type === "customer"` (i.e. a real session token proved
   * it). This is the only source lookup_my_orders reads — never tool input.
   */
  customerGid?: string;
}

/** Dispatch a tool call from the orchestrator loop. Never throws. */
export async function executeAgentTool(
  name: string,
  input: unknown,
  now = new Date(),
  context: AgentToolContext = {},
): Promise<unknown> {
  try {
    if (name === "resolve_date") {
      return resolveDeliveryDate((input ?? {}) as ResolveDeliveryDateInput, now);
    }
    if (name === "check_delivery_coverage") {
      return checkDeliveryCoverage((input ?? {}) as CheckDeliveryCoverageInput);
    }
    if (name === "get_available_slots") {
      return await getAvailableDeliverySlots(
        (input ?? {}) as GetAvailableDeliverySlotsInput,
        now,
      );
    }
    if (name === "search_products") {
      const raw = (input ?? {}) as {
        query?: string;
        min_price?: number;
        max_price?: number;
        sort?: "price_asc" | "price_desc";
        tags?: unknown;
        exclude_tags?: unknown;
        addons?: unknown;
      };
      const toStringArray = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      const tags = toStringArray(raw.tags);
      const excludeTags = toStringArray(raw.exclude_tags);
      const mapped: SearchShopProductsInput = {
        ...(raw.query ? { query: raw.query } : {}),
        ...(typeof raw.min_price === "number" ? { minPricePhp: raw.min_price } : {}),
        ...(typeof raw.max_price === "number" ? { maxPricePhp: raw.max_price } : {}),
        ...(raw.sort === "price_asc" || raw.sort === "price_desc" ? { sort: raw.sort } : {}),
        ...(tags.length ? { tags } : {}),
        ...(excludeTags.length ? { excludeTags } : {}),
        ...(raw.addons === true ? { addons: true } : {}),
      };
      return await searchShopProducts(mapped);
    }
    if (name === "get_best_sellers") {
      return await getBestSellers();
    }
    if (name === "get_product_details") {
      const raw = (input ?? {}) as { variant_id?: string };
      return await getVariantLive(raw.variant_id ?? "");
    }
    if (name === "lookup_order") {
      const raw = (input ?? {}) as { order_number?: string; zip?: string };
      // Channel-agnostic key: psid on Messenger, customer GID or an anonymous
      // conversation id on the web surfaces (agent-core defaults toolContext
      // to { threadId }, the live Messenger loop still passes { psid }).
      // Resolved ONCE and used for both the lockout check and the lookup
      // itself so the guard actually applies on every channel, not just
      // Messenger.
      const key = context.threadId ?? context.psid;
      if (!key) {
        return { ok: false, error: "lookup_order needs a conversation context." };
      }
      if (await isLookupLocked(key)) {
        return {
          ok: false,
          error:
            "Too many failed lookup attempts. Please try again later, or a human agent will follow up in this thread.",
        };
      }
      const orderNumber = raw.order_number ?? "";
      const zip = raw.zip ?? "";
      const result = await lookupOrderByNameAndZip({ orderName: orderNumber, zip });
      // Only a REAL wrong guess burns an attempt (MAJOR fix). The result's
      // `reason` is the source of truth, never the `error` string — that string
      // is identical for a wrong order number and a wrong zip on purpose.
      //   - "upstream"      Shopify down / MESSENGER_SHOP unset / GraphQL threw:
      //                     an outage must NEVER lock a blameless customer out
      //                     of order support for 30 minutes.
      //   - "ambiguous"     full search page, no exact match — inconclusive, so
      //                     the real order may sit past the page boundary.
      //   - "invalid_input" a missing field: a prompting issue, not a guess.
      if (result.ok) {
        await clearLookupFailures(key);
      } else if (result.reason === "mismatch") {
        await recordLookupFailure(key);
      } else {
        console.log(`[order-lookup] lookup failure not counted reason=${result.reason}`);
      }
      return result;
    }
    if (name === "lookup_my_orders") {
      // Authenticated surfaces only. The GID comes from the session-verified
      // channel identity — walang lockout dito dahil walang hinuhulaan: Shopify
      // already proved who this is.
      const customerGid = context.customerGid;
      if (!customerGid) {
        return { ok: false, error: "lookup_my_orders needs a signed-in customer." };
      }
      return await lookupOrdersByCustomerId(customerGid);
    }
    if (name === "update_order") {
      // Channel-agnostic key: the shared agent core passes threadId, the live
      // Messenger loop still passes psid. Same value on Messenger, so the
      // stored order state is untouched by this widening.
      const key = context.threadId ?? context.psid;
      if (!key) {
        return { ok: false, error: "update_order needs a conversation context." };
      }
      // Validators are injected here so messenger-orders has no import cycle
      // with this module (CODE validates; the LLM only relays language).
      return await updateMessengerOrderState(
        key,
        (input ?? {}) as UpdateOrderStateInput,
        {
          getVariant: getVariantLive,
          getSlots: getAvailableDeliverySlots,
          checkCoverage: checkDeliveryCoverage,
        },
        now,
      );
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}
