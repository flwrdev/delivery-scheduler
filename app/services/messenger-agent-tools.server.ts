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
import { getVariantLive, searchShopProducts } from "./messenger-products.server";
import type { SearchShopProductsInput } from "./messenger-products.server";
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
      "(e.g. 'may below 1000 ba kayo?' -> max_price=1000). A product carousel with photos and buttons " +
      "is sent to the customer AUTOMATICALLY after your reply — keep your text short and do NOT list " +
      "the products or prices yourself.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional keyword from the product title, e.g. 'rose', 'sunflower'.",
        },
        min_price: { type: "number", description: "Optional minimum price in PHP." },
        max_price: { type: "number", description: "Optional maximum price in PHP." },
      },
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
];

/** Dispatch a tool call from the orchestrator loop. Never throws. */
export async function executeAgentTool(
  name: string,
  input: unknown,
  now = new Date(),
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
      const raw = (input ?? {}) as { query?: string; min_price?: number; max_price?: number };
      const mapped: SearchShopProductsInput = {
        ...(raw.query ? { query: raw.query } : {}),
        ...(typeof raw.min_price === "number" ? { minPricePhp: raw.min_price } : {}),
        ...(typeof raw.max_price === "number" ? { maxPricePhp: raw.max_price } : {}),
      };
      return await searchShopProducts(mapped);
    }
    if (name === "get_product_details") {
      const raw = (input ?? {}) as { variant_id?: string };
      return await getVariantLive(raw.variant_id ?? "");
    }
    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}
