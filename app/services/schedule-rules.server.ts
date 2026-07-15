import prisma from "../db.server";
import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  cloneDeliveryScheduleRules,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import {
  deserializeStoredScheduleRules,
  validateScheduleRulesPatch,
  type ConfigHealthIssue,
} from "../lib/schedule-rules-schema";
import type { AdminGraphQLClient } from "./delivery-bookings.server";
import { loadAutomaticBookedCounts } from "./delivery-bookings.server";

export type {
  DeliveryScheduleCapacity,
  DeliveryScheduleRules,
  DeliveryScheduleSlot,
} from "../lib/delivery-availability";
export type { ConfigHealthIssue } from "../lib/schedule-rules-schema";

const DEFAULT_SCHEDULE_RULES: DeliveryScheduleRules = DEFAULT_DELIVERY_SCHEDULE_RULES;
const cloneScheduleRules = cloneDeliveryScheduleRules;

export interface ScheduleRulesWithHealth {
  rules: DeliveryScheduleRules;
  configHealth: ConfigHealthIssue[];
  /** Optimistic-concurrency counter; 0 when no config row exists yet. */
  version: number;
}

export type UpsertScheduleRulesResult =
  | { ok: true; rules: DeliveryScheduleRules; version: number }
  | { ok: false; code: "validation"; fieldErrors: Record<string, string> }
  | {
      ok: false;
      code: "stale_config";
      rules: DeliveryScheduleRules;
      version: number;
    };

type StoredConfigRow = {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slotsJson: string;
  disabledDatesJson: string;
  disabledSlotsJson: string;
  slotCapacityJson: string;
  version: number;
};

function serializeScheduleRules(shop: string, rules: DeliveryScheduleRules) {
  return {
    shop,
    timezone: rules.timezone,
    cutoffHour: rules.cutoffHour,
    prepHours: rules.prepHours,
    maxDays: rules.maxDays,
    slotsJson: JSON.stringify(rules.slots),
    disabledDatesJson: JSON.stringify(rules.disabledDates),
    disabledSlotsJson: JSON.stringify(rules.disabledSlots),
    slotCapacityJson: JSON.stringify(rules.slotCapacity),
  };
}

function readStoredRules(shop: string, row: StoredConfigRow): ScheduleRulesWithHealth {
  const { rules, configHealth } = deserializeStoredScheduleRules(row);

  if (configHealth.length) {
    // Loud, not silent (audit DEF-10): keep the raw column payloads in the log so
    // a corrupted blob can be recovered by hand instead of vanishing behind a
    // default fallback.
    console.error(
      `Delivery schedule config for ${shop} has ${configHealth.length} health issue(s):`,
      JSON.stringify({
        issues: configHealth,
        rawColumns: {
          timezone: row.timezone,
          slotsJson: row.slotsJson,
          disabledDatesJson: row.disabledDatesJson,
          disabledSlotsJson: row.disabledSlotsJson,
          slotCapacityJson: row.slotCapacityJson,
        },
      }),
    );
  }

  return { rules, configHealth, version: row.version };
}

/**
 * Rules read WITH config-health detail (admin surfaces). Pure read: no row is
 * created here — the config row is first written by an editor save, never as a
 * side effect of reading (audit PERF-2).
 */
export async function getScheduleRulesWithHealth(
  shop?: string,
): Promise<ScheduleRulesWithHealth> {
  if (!shop) {
    return {
      rules: cloneScheduleRules(DEFAULT_SCHEDULE_RULES),
      configHealth: [],
      version: 0,
    };
  }

  const row = await prisma.deliveryScheduleConfig.findUnique({ where: { shop } });
  if (!row) {
    return {
      rules: cloneScheduleRules(DEFAULT_SCHEDULE_RULES),
      configHealth: [],
      version: 0,
    };
  }

  return readStoredRules(shop, row);
}

export async function getScheduleRules(shop?: string): Promise<DeliveryScheduleRules> {
  const { rules } = await getScheduleRulesWithHealth(shop);
  return rules;
}

function applyAutomaticBookedCounts(
  rules: DeliveryScheduleRules,
  bookedCounts: Record<string, Record<string, number>>,
): DeliveryScheduleRules {
  // Overlay live booked totals onto the configured slot capacity map so merchants edit
  // capacity in one place while booked counts continue to come from real orders.
  return {
    ...rules,
    slotCapacity: Object.fromEntries(
      Object.entries(rules.slotCapacity).map(([date, capacities]) => [
        date,
        Object.fromEntries(
          Object.entries(capacities).map(([slot, values]) => [
            slot,
            {
              ...values,
              booked: bookedCounts[date]?.[slot] ?? 0,
            },
          ]),
        ),
      ]),
    ),
  };
}

export async function getScheduleRulesWithBookedCounts(
  shop: string | undefined,
  admin?: AdminGraphQLClient,
): Promise<DeliveryScheduleRules> {
  const rules = await getScheduleRules(shop);

  if (!shop || !admin || !Object.keys(rules.slotCapacity).length) {
    return rules;
  }

  try {
    // Fail open to the persisted rules if live order aggregation breaks; delivery setup
    // should remain editable and readable even when Admin order queries fail.
    const bookedCounts = await loadAutomaticBookedCounts(admin, rules);
    return applyAutomaticBookedCounts(rules, bookedCounts);
  } catch (error) {
    console.error("Failed to load automatic delivery booked counts:", error);
    return rules;
  }
}

/**
 * Strictly validated, optimistically guarded write. Invalid fields reject with
 * per-field errors (never silently kept-old or dropped — audit DEF-9); when
 * `expectedVersion` is provided (or a row already exists) the update only
 * applies if no other writer has bumped the version since it was read
 * (audit DEF-11 last-writer-wins).
 */
export async function upsertScheduleRules(
  shop: string,
  patch: Partial<DeliveryScheduleRules>,
  options: { expectedVersion?: number } = {},
): Promise<UpsertScheduleRulesResult> {
  const current = await getScheduleRulesWithHealth(shop);

  const validation = validateScheduleRulesPatch(patch, current.rules.slots);
  if (!validation.ok) {
    return { ok: false, code: "validation", fieldErrors: validation.fieldErrors };
  }

  const guardVersion = options.expectedVersion ?? current.version;
  const nextRules: DeliveryScheduleRules = {
    ...cloneScheduleRules(current.rules),
    ...validation.patch,
  };

  const existingRow = await prisma.deliveryScheduleConfig.findUnique({
    where: { shop },
    select: { version: true },
  });

  if (!existingRow) {
    if (guardVersion !== 0) {
      return { ok: false, code: "stale_config", rules: current.rules, version: 0 };
    }

    try {
      const created = await prisma.deliveryScheduleConfig.create({
        data: { ...serializeScheduleRules(shop, nextRules), version: 1 },
      });
      return {
        ok: true,
        rules: readStoredRules(shop, created).rules,
        version: created.version,
      };
    } catch (error) {
      // Unique-constraint race: another writer created the row between our read
      // and this create. Surface it as a stale save instead of a 500.
      if ((error as { code?: string })?.code === "P2002") {
        const fresh = await getScheduleRulesWithHealth(shop);
        return {
          ok: false,
          code: "stale_config",
          rules: fresh.rules,
          version: fresh.version,
        };
      }
      throw error;
    }
  }

  const updated = await prisma.deliveryScheduleConfig.updateMany({
    where: { shop, version: guardVersion },
    data: { ...serializeScheduleRules(shop, nextRules), version: guardVersion + 1 },
  });

  if (updated.count === 0) {
    const fresh = await getScheduleRulesWithHealth(shop);
    return {
      ok: false,
      code: "stale_config",
      rules: fresh.rules,
      version: fresh.version,
    };
  }

  const fresh = await getScheduleRulesWithHealth(shop);
  return { ok: true, rules: fresh.rules, version: fresh.version };
}
