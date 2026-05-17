import prisma from "../db.server";
import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  cloneDeliveryScheduleRules,
  isIsoDateString,
  type DeliveryScheduleCapacity,
  type DeliveryScheduleRules,
  type DeliveryScheduleSlot,
} from "../lib/delivery-availability";
import type { AdminGraphQLClient } from "./delivery-bookings.server";
import { loadAutomaticBookedCounts } from "./delivery-bookings.server";

export type {
  DeliveryScheduleCapacity,
  DeliveryScheduleRules,
  DeliveryScheduleSlot,
} from "../lib/delivery-availability";

interface DeliveryScheduleConfigRecord {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slotsJson: string;
  disabledDatesJson: string;
  disabledSlotsJson: string;
  slotCapacityJson: string;
}

const DEFAULT_SCHEDULE_RULES: DeliveryScheduleRules = DEFAULT_DELIVERY_SCHEDULE_RULES;
const cloneScheduleRules = cloneDeliveryScheduleRules;

function uniqueStringValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseStringArray(jsonValue: string, fallbackValue: string[]): string[] {
  try {
    const parsed = JSON.parse(jsonValue);
    if (!Array.isArray(parsed)) return [...fallbackValue];

    return uniqueStringValues(
      parsed.filter((value): value is string => typeof value === "string"),
    );
  } catch {
    return [...fallbackValue];
  }
}

function parseSlots(
  jsonValue: string,
  fallbackValue: DeliveryScheduleSlot[],
): DeliveryScheduleSlot[] {
  try {
    const parsed = JSON.parse(jsonValue);
    if (!Array.isArray(parsed)) return fallbackValue.map((slot) => ({ ...slot }));

    const seenValues = new Set<string>();
    const slots = parsed
      .filter(
        (slot) =>
          slot &&
          typeof slot.display === "string" &&
          slot.display &&
          typeof slot.value === "string" &&
          slot.value,
      )
      .flatMap((slot) => {
        if (seenValues.has(slot.value)) {
          return [];
        }

        seenValues.add(slot.value);
        return [
          {
            display: slot.display,
            value: slot.value,
          },
        ];
      });

    return slots.length ? slots : fallbackValue.map((slot) => ({ ...slot }));
  } catch {
    return fallbackValue.map((slot) => ({ ...slot }));
  }
}

function parseDisabledSlots(
  jsonValue: string,
  fallbackValue: Record<string, string[]>,
): Record<string, string[]> {
  try {
    const parsed = JSON.parse(jsonValue);
    if (!parsed || typeof parsed !== "object") {
      return Object.fromEntries(
        Object.entries(fallbackValue).map(([date, slots]) => [date, [...slots]]),
      );
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([date, slots]) => {
        if (!isIsoDateString(date) || !Array.isArray(slots)) return [];
        return [
          [
            date,
            uniqueStringValues(
              slots.filter((slot): slot is string => typeof slot === "string"),
            ),
          ],
        ];
      }),
    );
  } catch {
    return Object.fromEntries(
      Object.entries(fallbackValue).map(([date, slots]) => [date, [...slots]]),
    );
  }
}

function parseSlotCapacity(
  jsonValue: string,
  fallbackValue: Record<string, Record<string, DeliveryScheduleCapacity>>,
): Record<string, Record<string, DeliveryScheduleCapacity>> {
  try {
    const parsed = JSON.parse(jsonValue);
    if (!parsed || typeof parsed !== "object") {
      return cloneScheduleRules({
        ...DEFAULT_SCHEDULE_RULES,
        slotCapacity: fallbackValue,
      }).slotCapacity;
    }

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([date, capacities]) => {
        if (!isIsoDateString(date) || !capacities || typeof capacities !== "object") {
          return [];
        }

        const slotCapacities = Object.fromEntries(
          Object.entries(capacities).flatMap(([slot, values]) => {
            const capacity = Number(values && values.capacity);
            const booked = Number(values && values.booked);

            if (!Number.isFinite(capacity) || !Number.isFinite(booked)) {
              return [];
            }

            return [[slot, { capacity, booked }]];
          }),
        );

        return [[date, slotCapacities]];
      }),
    );
  } catch {
    return cloneScheduleRules({
      ...DEFAULT_SCHEDULE_RULES,
      slotCapacity: fallbackValue,
    }).slotCapacity;
  }
}

function normalizeScheduleRules(
  rules: Partial<DeliveryScheduleRules>,
  baseRules: DeliveryScheduleRules = DEFAULT_SCHEDULE_RULES,
): DeliveryScheduleRules {
  // Sanitize stored or admin-provided values against the current defaults so malformed
  // JSON never leaks into the shared delivery validation contract.
  const normalizedRules = cloneScheduleRules(baseRules);

  if (typeof rules.timezone === "string" && rules.timezone) {
    normalizedRules.timezone = rules.timezone;
  }

  const cutoffHour = Number(rules.cutoffHour);
  if (Number.isInteger(cutoffHour) && cutoffHour >= 0 && cutoffHour <= 23) {
    normalizedRules.cutoffHour = cutoffHour;
  }

  const prepHours = Number(rules.prepHours);
  if (Number.isInteger(prepHours) && prepHours >= 0) {
    normalizedRules.prepHours = prepHours;
  }

  const maxDays = Number(rules.maxDays);
  if (Number.isInteger(maxDays) && maxDays >= 1) {
    normalizedRules.maxDays = maxDays;
  }

  if (Array.isArray(rules.slots)) {
    const seenValues = new Set<string>();
    const slots = rules.slots
      .filter(
        (slot) =>
          slot &&
          typeof slot.display === "string" &&
          slot.display &&
          typeof slot.value === "string" &&
          slot.value,
      )
      .flatMap((slot) => {
        if (seenValues.has(slot.value)) {
          return [];
        }

        seenValues.add(slot.value);
        return [
          {
            display: slot.display,
            value: slot.value,
          },
        ];
      });

    if (slots.length) {
      normalizedRules.slots = slots;
    }
  }

  if (Array.isArray(rules.disabledDates)) {
    normalizedRules.disabledDates = uniqueStringValues(
      rules.disabledDates.filter(
        (value): value is string =>
          typeof value === "string" && isIsoDateString(value),
      ),
    );
  }

  if (rules.disabledSlots && typeof rules.disabledSlots === "object") {
    normalizedRules.disabledSlots = Object.fromEntries(
      Object.entries(rules.disabledSlots).flatMap(([date, slots]) => {
        if (!isIsoDateString(date) || !Array.isArray(slots)) return [];
        return [
          [
            date,
            uniqueStringValues(
              slots.filter((slot): slot is string => typeof slot === "string"),
            ),
          ],
        ];
      }),
    );
  }

  if (rules.slotCapacity && typeof rules.slotCapacity === "object") {
    normalizedRules.slotCapacity = Object.fromEntries(
      Object.entries(rules.slotCapacity).flatMap(([date, capacities]) => {
        if (!isIsoDateString(date) || !capacities || typeof capacities !== "object") {
          return [];
        }

        const slotCapacities = Object.fromEntries(
          Object.entries(capacities).flatMap(([slot, values]) => {
            const capacity = Number(values && values.capacity);
            const booked = Number(values && values.booked);

            if (!Number.isFinite(capacity) || !Number.isFinite(booked)) {
              return [];
            }

            return [[slot, { capacity, booked }]];
          }),
        );

        return [[date, slotCapacities]];
      }),
    );
  }

  return normalizedRules;
}

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

function deserializeScheduleRules(record: DeliveryScheduleConfigRecord): DeliveryScheduleRules {
  // Rebuild the persisted JSON blobs into a fully shaped rules object so downstream
  // callers can treat every field as present and already normalized.
  return normalizeScheduleRules({
    timezone: record.timezone,
    cutoffHour: record.cutoffHour,
    prepHours: record.prepHours,
    maxDays: record.maxDays,
    slots: parseSlots(record.slotsJson, DEFAULT_SCHEDULE_RULES.slots),
    disabledDates: parseStringArray(
      record.disabledDatesJson,
      DEFAULT_SCHEDULE_RULES.disabledDates,
    ),
    disabledSlots: parseDisabledSlots(
      record.disabledSlotsJson,
      DEFAULT_SCHEDULE_RULES.disabledSlots,
    ),
    slotCapacity: parseSlotCapacity(
      record.slotCapacityJson,
      DEFAULT_SCHEDULE_RULES.slotCapacity,
    ),
  });
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

export async function getScheduleRules(shop?: string): Promise<DeliveryScheduleRules> {
  if (!shop) {
    return cloneScheduleRules(DEFAULT_SCHEDULE_RULES);
  }

  // Ensure every shop has a persisted config row the first time rules are requested so
  // all other delivery code can assume a stable storage record exists.
  const record = await prisma.deliveryScheduleConfig.upsert({
    where: { shop },
    update: {},
    create: serializeScheduleRules(shop, DEFAULT_SCHEDULE_RULES),
  });

  return deserializeScheduleRules(record);
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

export async function upsertScheduleRules(
  shop: string,
  rules: Partial<DeliveryScheduleRules>,
): Promise<DeliveryScheduleRules> {
  const currentRules = await getScheduleRules(shop);
  // Normalize before writing so partial admin editor payloads cannot persist invalid
  // slot, date, or capacity structures into the shared delivery contract.
  const normalizedRules = normalizeScheduleRules(rules, currentRules);
  const record = await prisma.deliveryScheduleConfig.upsert({
    where: { shop },
    update: serializeScheduleRules(shop, normalizedRules),
    create: serializeScheduleRules(shop, normalizedRules),
  });

  return deserializeScheduleRules(record);
}
