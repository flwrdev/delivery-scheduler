// Sidekick app-data tool helpers — READ-ONLY.
//
// These back the three `/sidekick/tools/*` routes that the
// `delivery-sidekick-data` extension calls from the Sidekick sandbox. Nothing
// in this module writes: no mutations, no metafields, no tags, no Prisma
// writes. It only reshapes what `schedule-rules.server.ts` already loads plus
// one read-only Admin GraphQL order lookup.
//
// Two hard constraints from the Sidekick contract (docs/decisions.md ADR-18):
//   1. Every tool response must stay under 4,000 tokens — so every list here
//      is capped and reports how much it dropped, never a raw dump.
//   2. Every upstream failure must answer `200 + {ok:false, error}` (ADR-11) —
//      the routes own that, this module just never throws for shaped input.

import {
  getShopLocalDate,
  isIsoDateString,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import type { AdminGraphQLClient } from "./delivery-bookings.server";
import type { ScheduleRulesDetailed } from "./schedule-rules.server";

/** Response-size caps. Deliberately small — Sidekick reads prose, not dumps. */
export const MAX_BOOKED_COUNT_DATES = 14;
export const MAX_SLOTS_PER_DATE = 12;
export const MAX_LISTED_SLOTS = 20;
export const MAX_LISTED_SAMPLE = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Input parsing
// ─────────────────────────────────────────────────────────────────────────────

export type JsonInputResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Read a Sidekick tool POST body. An absent/empty body is legal (the tools with
 * no required input), a non-object or unparseable body is a caller error that
 * the route turns into `200 + ok:false` with this message.
 */
export async function readJsonInput(request: Request): Promise<JsonInputResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: "Could not read the request body." };
  }

  if (!text.trim()) return { ok: true, input: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "Request body was not valid JSON. Send a JSON object.",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Request body must be a JSON object of tool inputs.",
    };
  }

  return { ok: true, input: parsed as Record<string, unknown> };
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// get_delivery_booked_counts
// ─────────────────────────────────────────────────────────────────────────────

export interface BookedCountsQuery {
  /** Single exact date. Mutually exclusive with the range fields. */
  date?: string;
  startDate?: string;
  endDate?: string;
}

export type BookedCountsInputResult =
  | { ok: true; query: BookedCountsQuery }
  | { ok: false; error: string };

export function parseBookedCountsInput(
  input: Record<string, unknown>,
): BookedCountsInputResult {
  const date = optionalString(input.date);
  const startDate = optionalString(input.start_date ?? input.startDate);
  const endDate = optionalString(input.end_date ?? input.endDate);

  for (const [label, value] of [
    ["date", date],
    ["start_date", startDate],
    ["end_date", endDate],
  ] as const) {
    if (value && !isIsoDateString(value)) {
      return {
        ok: false,
        error: `"${label}" must be a calendar date in YYYY-MM-DD format (got "${value}").`,
      };
    }
  }

  if (date && (startDate || endDate)) {
    return {
      ok: false,
      error:
        'Pass either "date" for a single day or "start_date"/"end_date" for a range, not both.',
    };
  }

  if (startDate && endDate && startDate > endDate) {
    return { ok: false, error: '"start_date" must not be after "end_date".' };
  }

  return {
    ok: true,
    query: {
      ...(date ? { date } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    },
  };
}

export interface BookedCountsSlotRow {
  slot: string;
  capacity: number;
  /**
   * NULL when `countsStatus` is "error" or "skipped" (M-2). On those statuses
   * the only numbers we hold are the STORED counts, which are stale and
   * typically 0 — emitting them would let Sidekick tell the merchant "10 of 10
   * free" on a fully booked day during an Admin outage. Capacity is still real
   * (it is config, not a scan result), so it is kept.
   */
  booked: number | null;
  remaining: number | null;
  full: boolean | null;
  blocked: boolean;
}

export interface BookedCountsDateRow {
  date: string;
  dateDisabled: boolean;
  slots: BookedCountsSlotRow[];
  slotsOmitted: number;
}

export interface BookedCountsSummary {
  timezone: string;
  today: string;
  /** Straight from `countsMeta.status` — Sidekick must be able to say "partial". */
  countsStatus: ScheduleRulesDetailed["countsMeta"]["status"];
  countsFetchedAt: string | null;
  countsFromCache: boolean;
  /** One plain sentence explaining how far to trust the numbers. */
  countsNote: string;
  dates: BookedCountsDateRow[];
  datesReturned: number;
  datesMatched: number;
  datesOmitted: number;
  capacityTrackedDates: number;
  truncatedDates?: string[];
  /**
   * Dates the caller explicitly asked for that have NO capacity configured
   * (L-12). Without this, "not tracked" and "nothing booked" both look like an
   * empty `dates` array. An untracked date has no per-slot cap at all — only
   * the global rules (cutoff, prep hours, booking window, blocked dates) apply.
   */
  untrackedRequestedDates?: string[];
}

const COUNTS_NOTES: Record<
  ScheduleRulesDetailed["countsMeta"]["status"],
  string
> = {
  ok: "Booked counts are live (re-derived from Shopify orders, cached up to 60 seconds).",
  partial:
    "Booked counts are a LOWER BOUND — an order-scan cap clipped the results, so some dates may show fewer bookings than reality.",
  untracked:
    "No capacity is configured for any date, so there are no booked counts to report.",
  skipped:
    "Booked counts were not computed on this request (no Admin session available).",
  error:
    "The Shopify order scan failed, so booked counts are unavailable. The stored capacity numbers are still correct.",
};

export function summarizeBookedCounts(
  detailed: ScheduleRulesDetailed,
  query: BookedCountsQuery,
  now = new Date(),
): BookedCountsSummary {
  const { rules, countsMeta } = detailed;
  const today = getShopLocalDate(rules.timezone, now);

  const allTracked = Object.keys(rules.slotCapacity)
    .filter(isIsoDateString)
    .sort();

  // Default window: today forward. An explicit date/range wins, including into
  // the past — the merchant may be reconciling yesterday.
  const start = query.date ?? query.startDate ?? today;
  const end = query.date ?? query.endDate ?? null;

  const matched = allTracked.filter(
    (date) => (!start || date >= start) && (!end || date <= end),
  );

  const kept = matched.slice(0, MAX_BOOKED_COUNT_DATES);
  const disabledDates = new Set(rules.disabledDates);

  // M-2: on "error"/"skipped" the live scan never produced numbers, so the
  // `booked` values still sitting on the rules are stale config leftovers
  // (almost always 0). Report them as unknown rather than as zero bookings.
  const countsUsable =
    countsMeta.status === "ok" ||
    countsMeta.status === "partial" ||
    countsMeta.status === "untracked";

  const dates: BookedCountsDateRow[] = kept.map((date) => {
    const blockedSlots = new Set(rules.disabledSlots[date] ?? []);
    const entries = Object.entries(rules.slotCapacity[date] ?? {});
    const slots = entries.slice(0, MAX_SLOTS_PER_DATE).map(([slot, entry]) => {
      const capacity = Number(entry?.capacity) || 0;
      const booked = Number(entry?.booked) || 0;
      if (!countsUsable) {
        return {
          slot,
          capacity,
          booked: null,
          remaining: null,
          full: null,
          blocked: blockedSlots.has(slot),
        };
      }
      return {
        slot,
        capacity,
        booked,
        remaining: Math.max(0, capacity - booked),
        full: capacity > 0 && booked >= capacity,
        blocked: blockedSlots.has(slot),
      };
    });

    return {
      date,
      dateDisabled: disabledDates.has(date),
      slots,
      slotsOmitted: Math.max(0, entries.length - slots.length),
    };
  });

  const truncatedDates = countsMeta.truncation?.affectedDates?.slice(
    0,
    MAX_LISTED_SAMPLE,
  );

  // L-12: only EXPLICITLY named dates can be reported as untracked — the
  // default today-forward window has no named dates to miss.
  const trackedSet = new Set(allTracked);
  const untrackedRequestedDates = [
    ...(query.date ? [query.date] : []),
    ...(query.startDate && query.startDate === query.endDate
      ? [query.startDate]
      : []),
  ].filter((date, index, list) => !trackedSet.has(date) && list.indexOf(date) === index);

  return {
    timezone: rules.timezone,
    today,
    countsStatus: countsMeta.status,
    countsFetchedAt: countsMeta.fetchedAt,
    countsFromCache: countsMeta.fromCache,
    countsNote: COUNTS_NOTES[countsMeta.status],
    dates,
    datesReturned: dates.length,
    datesMatched: matched.length,
    datesOmitted: Math.max(0, matched.length - dates.length),
    capacityTrackedDates: allTracked.length,
    ...(truncatedDates?.length ? { truncatedDates } : {}),
    ...(untrackedRequestedDates.length ? { untrackedRequestedDates } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// get_schedule_config_summary
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleConfigSummary {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slots: DeliveryScheduleRules["slots"];
  slotCount: number;
  slotsOmitted: number;
  disabledDatesCount: number;
  disabledDatesSample: string[];
  blockedSlotDatesCount: number;
  blockedSlotsSample: Array<{ date: string; slots: string[] }>;
  capacityTrackedDatesCount: number;
  capacityTrackedDatesSample: string[];
  configHealthIssueCount: number;
  configHealthSample: string[];
  version: number;
}

/**
 * Cheap config-only view. Deliberately built from `getScheduleRulesWithHealth`
 * (no Admin scan) — nothing here needs live booked counts.
 */
export function summarizeScheduleConfig(
  rules: DeliveryScheduleRules,
  configHealth: Array<{ column: string; message: string }>,
  version: number,
): ScheduleConfigSummary {
  const disabledDates = [...rules.disabledDates].sort();
  const blockedSlotDates = Object.entries(rules.disabledSlots).filter(
    ([, slots]) => Array.isArray(slots) && slots.length > 0,
  );
  const trackedDates = Object.keys(rules.slotCapacity)
    .filter(isIsoDateString)
    .sort();

  return {
    timezone: rules.timezone,
    cutoffHour: rules.cutoffHour,
    prepHours: rules.prepHours,
    maxDays: rules.maxDays,
    slots: rules.slots.slice(0, MAX_LISTED_SLOTS),
    slotCount: rules.slots.length,
    slotsOmitted: Math.max(0, rules.slots.length - MAX_LISTED_SLOTS),
    disabledDatesCount: disabledDates.length,
    disabledDatesSample: disabledDates.slice(0, MAX_LISTED_SAMPLE),
    blockedSlotDatesCount: blockedSlotDates.length,
    blockedSlotsSample: blockedSlotDates
      .slice(0, MAX_LISTED_SAMPLE)
      .map(([date, slots]) => ({ date, slots: slots.slice(0, MAX_SLOTS_PER_DATE) })),
    capacityTrackedDatesCount: trackedDates.length,
    capacityTrackedDatesSample: trackedDates.slice(0, MAX_LISTED_SAMPLE),
    configHealthIssueCount: configHealth.length,
    configHealthSample: configHealth
      .slice(0, MAX_LISTED_SAMPLE)
      .map((issue) => `${issue.column}: ${issue.message}`),
    version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// get_order_delivery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * READ-ONLY. One order, by name. Mirrors the delivery fields `/app/orders`
 * already reads (api.md §2) — the canonical `custom.*` pair plus the legacy
 * `delivery.*` mirrors as a fallback, the `$app` reschedule state, and the
 * additive `delivery.sync_status` flag from the orders/create webhook.
 */
export const SIDEKICK_ORDER_DELIVERY_QUERY = `#graphql
  query SidekickOrderDelivery($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        createdAt
        cancelledAt
        displayFulfillmentStatus
        displayFinancialStatus
        customAttributes {
          key
          value
        }
        customDate: metafield(namespace: "custom", key: "date") {
          value
        }
        customTimeSlot: metafield(namespace: "custom", key: "time_slot") {
          value
        }
        legacyDate: metafield(namespace: "delivery", key: "date") {
          value
        }
        legacyTimeSlot: metafield(namespace: "delivery", key: "time_slot") {
          value
        }
        syncStatus: metafield(namespace: "delivery", key: "sync_status") {
          value
        }
        rescheduleStatus: metafield(namespace: "$app", key: "reschedule_status") {
          value
        }
        rescheduleRequestedAt: metafield(namespace: "$app", key: "reschedule_requested_at") {
          value
        }
        rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
          jsonValue
        }
      }
    }
  }
`;

export type OrderNameResult =
  | { ok: true; searchQuery: string; normalizedName: string }
  | { ok: false; error: string };

/**
 * Accepts "#4111", "4111", or " #4111 ". A bare digit run gets the "#" that
 * Shopify's `name:` term expects; anything else (custom order prefixes) is
 * passed through verbatim.
 */
export function buildOrderNameQuery(raw: unknown): OrderNameResult {
  const value = optionalString(raw);
  if (!value) {
    return {
      ok: false,
      error:
        'Provide the order number, for example "#4111". Pass it as "order_name".',
    };
  }
  if (value.length > 64) {
    return { ok: false, error: "Order number is too long to be valid." };
  }
  if (/["\\]/.test(value)) {
    return { ok: false, error: 'Order number must not contain quotes or backslashes.' };
  }

  const normalizedName = /^\d+$/.test(value) ? `#${value}` : value;
  return {
    ok: true,
    normalizedName,
    searchQuery: `name:"${normalizedName}"`,
  };
}

export interface OrderDeliverySummary {
  id: string;
  legacyId: string;
  name: string;
  createdAt: string | null;
  cancelledAt: string | null;
  deliveryDate: string | null;
  deliveryTimeSlot: string | null;
  /** Where the date/slot was read from — the canonical metafields or a fallback. */
  deliverySource: "metafield" | "legacy_metafield" | "custom_attribute" | null;
  deliverySyncStatus: string | null;
  rescheduleStatus: string | null;
  rescheduleRequestedAt: string | null;
  rescheduleCount: number;
  displayFulfillmentStatus: string | null;
  displayFinancialStatus: string | null;
  /** Deep link the merchant can follow to reschedule this order in the app. */
  appUrl: string;
}

type RawOrderNode = {
  id?: string;
  name?: string;
  createdAt?: string | null;
  cancelledAt?: string | null;
  displayFulfillmentStatus?: string | null;
  displayFinancialStatus?: string | null;
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
  customDate?: { value?: string | null } | null;
  customTimeSlot?: { value?: string | null } | null;
  legacyDate?: { value?: string | null } | null;
  legacyTimeSlot?: { value?: string | null } | null;
  syncStatus?: { value?: string | null } | null;
  rescheduleStatus?: { value?: string | null } | null;
  rescheduleRequestedAt?: { value?: string | null } | null;
  rescheduleHistory?: { jsonValue?: unknown } | null;
};

function attr(node: RawOrderNode, key: string): string | null {
  const found = node.customAttributes?.find(
    (a) => (a?.key ?? "").toLowerCase() === key.toLowerCase(),
  );
  const value = optionalString(found?.value);
  return value || null;
}

function metafieldValue(field: { value?: string | null } | null | undefined) {
  const value = optionalString(field?.value);
  return value || null;
}

export function summarizeOrderDelivery(node: RawOrderNode): OrderDeliverySummary {
  const id = node.id ?? "";
  const legacyId = id.split("/").pop() || id;

  const canonicalDate = metafieldValue(node.customDate);
  const canonicalSlot = metafieldValue(node.customTimeSlot);
  const legacyDate = metafieldValue(node.legacyDate);
  const legacySlot = metafieldValue(node.legacyTimeSlot);
  const attrDate = attr(node, "Delivery Date");
  const attrSlot = attr(node, "Delivery Time");

  // L-14: the source is keyed off EITHER field resolving. A slot-only order
  // (date cleared, slot still set) used to report source `null` while handing
  // back a real slot, which reads as "we made this up".
  let deliveryDate = canonicalDate;
  let deliveryTimeSlot = canonicalSlot;
  let deliverySource: OrderDeliverySummary["deliverySource"] =
    canonicalDate || canonicalSlot ? "metafield" : null;

  if (!deliveryDate && !deliveryTimeSlot && (legacyDate || legacySlot)) {
    deliveryDate = legacyDate;
    deliveryTimeSlot = legacySlot;
    deliverySource = "legacy_metafield";
  }
  if (!deliveryDate && !deliveryTimeSlot && (attrDate || attrSlot)) {
    deliveryDate = attrDate;
    deliveryTimeSlot = attrSlot;
    deliverySource = "custom_attribute";
  }
  if (deliveryDate && !deliveryTimeSlot) {
    deliveryTimeSlot = canonicalSlot ?? legacySlot ?? attrSlot;
  }
  if (deliveryTimeSlot && !deliveryDate) {
    deliveryDate = canonicalDate ?? legacyDate ?? attrDate;
  }

  const history = node.rescheduleHistory?.jsonValue;
  const rescheduleCount = Array.isArray(history) ? history.length : 0;

  return {
    id,
    legacyId,
    name: node.name ?? "",
    createdAt: node.createdAt ?? null,
    cancelledAt: node.cancelledAt ?? null,
    deliveryDate,
    deliveryTimeSlot,
    deliverySource,
    deliverySyncStatus: metafieldValue(node.syncStatus),
    rescheduleStatus: metafieldValue(node.rescheduleStatus),
    rescheduleRequestedAt: metafieldValue(node.rescheduleRequestedAt),
    rescheduleCount,
    displayFulfillmentStatus: node.displayFulfillmentStatus ?? null,
    displayFinancialStatus: node.displayFinancialStatus ?? null,
    appUrl: `/app/orders?order=${encodeURIComponent(legacyId)}&search=${encodeURIComponent(node.name ?? "")}`,
  };
}

export type OrderDeliveryLookup =
  | { ok: true; order: OrderDeliverySummary }
  | { ok: false; error: string };

/** Single read-only Admin GraphQL search. Never mutates, never throws shaped. */
export async function fetchOrderDelivery(
  admin: AdminGraphQLClient,
  searchQuery: string,
  normalizedName: string,
): Promise<OrderDeliveryLookup> {
  const response = await admin.graphql(SIDEKICK_ORDER_DELIVERY_QUERY, {
    variables: { query: searchQuery },
  });
  const body = (await response.json()) as {
    data?: { orders?: { nodes?: RawOrderNode[] } };
    errors?: Array<{ message?: string }>;
  };

  if (body.errors?.length) {
    return {
      ok: false,
      error: `Shopify rejected the order lookup: ${body.errors
        .map((e) => e?.message ?? "unknown error")
        .slice(0, 3)
        .join("; ")}`,
    };
  }

  const node = body.data?.orders?.nodes?.[0];
  if (!node) {
    return {
      ok: false,
      error: `No order named ${normalizedName} was found in this store.`,
    };
  }

  return { ok: true, order: summarizeOrderDelivery(node) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth boundary (M-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CORS headers mirroring what `authenticate.admin`'s `cors` helper sets.
 *
 * Needed for exactly one path: when `authenticate.admin` itself THROWS a
 * non-Response error we have no `cors` helper to wrap the reply in, because the
 * helper is part of the value that call never returned. Keep this minimal and
 * in sync with the library helper.
 */
export const SIDEKICK_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export type SidekickAuthResult<T> =
  | { ok: true; context: T }
  | { ok: false; response: Response };

/**
 * Run `authenticate.admin` without letting a session-store failure escape as a
 * 5xx (M-3).
 *
 * `authenticate.admin` legitimately THROWS a `Response` for the platform's own
 * auth flow (401 / redirect to token exchange) — those must pass through
 * untouched or embedded auth breaks. But it also touches Prisma session storage,
 * which on this deployment sits behind Neon and can cold-start-timeout. That
 * throw is a plain `Error`, which React Router turns into a 500 — and a 500 from
 * this origin is replaced by Cloudflare's HTML error page, the precise ADR-11
 * failure that breaks a sandbox fetch. So a non-Response throw becomes the same
 * `200 + {ok:false}` every other failure in these routes produces.
 */
export async function authenticateSidekickRequest<T>(
  authenticateAdmin: (request: Request) => Promise<T>,
  request: Request,
): Promise<SidekickAuthResult<T>> {
  try {
    return { ok: true, context: await authenticateAdmin(request) };
  } catch (error) {
    // Platform auth responses are control flow, not failures — rethrow as-is.
    if (error instanceof Response) throw error;

    console.error("Sidekick tool auth failed before a session was available:", error);
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error:
            "The Delivery Scheduler app's session store is unavailable right now. Try again in a moment.",
        },
        { headers: SIDEKICK_CORS_HEADERS },
      ),
    };
  }
}
