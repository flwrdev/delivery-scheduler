import { describe, expect, it } from "vitest";

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";
import {
  deserializeStoredScheduleRules,
  isRealIsoDate,
  isValidTimeZone,
  parseStrictInteger,
  validateScheduleRulesPatch,
} from "../app/lib/schedule-rules-schema";

const SLOTS = [
  { display: "Morning", value: "9AM-12PM" },
  { display: "Afternoon", value: "3PM-6PM" },
];

describe("parseStrictInteger — the DEF-8 gate", () => {
  it("accepts integer numbers and digit-only strings", () => {
    expect(parseStrictInteger(17)).toBe(17);
    expect(parseStrictInteger("17")).toBe(17);
    expect(parseStrictInteger("0")).toBe(0);
  });

  it("rejects everything Number() silently coerces", () => {
    expect(parseStrictInteger("")).toBeNull();
    expect(parseStrictInteger("  ")).toBeNull();
    expect(parseStrictInteger("1e2")).toBeNull();
    expect(parseStrictInteger("0x10")).toBeNull();
    expect(parseStrictInteger(1.5)).toBeNull();
    expect(parseStrictInteger(-1)).toBeNull();
    expect(parseStrictInteger(null)).toBeNull();
    expect(parseStrictInteger(undefined)).toBeNull();
  });
});

describe("isRealIsoDate — calendar-real, not regex-only", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isRealIsoDate("2026-07-15")).toBe(true);
    expect(isRealIsoDate("2028-02-29")).toBe(true); // leap day
    expect(isRealIsoDate("2026-02-31")).toBe(false);
    expect(isRealIsoDate("2026-13-01")).toBe(false);
    expect(isRealIsoDate("07/15/2026")).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA names and rejects typos", () => {
    expect(isValidTimeZone("Asia/Manila")).toBe(true);
    expect(isValidTimeZone("Asia/Manilla")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("validateScheduleRulesPatch — strict write gate", () => {
  it("accepts a well-formed full patch", () => {
    const result = validateScheduleRulesPatch(
      {
        timezone: "Asia/Manila",
        cutoffHour: 17,
        prepHours: 2,
        maxDays: 30,
        slots: SLOTS,
        disabledDates: ["2026-07-21", "2026-07-21"],
        disabledSlots: { "2026-07-22": ["3PM-6PM"] },
        slotCapacity: { "2026-07-23": { "9AM-12PM": { capacity: 5, booked: 99 } } },
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.disabledDates).toEqual(["2026-07-21"]); // deduped
      // booked is vestigial and pinned to 0 no matter what was posted
      expect(result.patch.slotCapacity).toEqual({
        "2026-07-23": { "9AM-12PM": { capacity: 5, booked: 0 } },
      });
    }
  });

  it("rejects invalid scalars with field errors instead of keeping old values", () => {
    const result = validateScheduleRulesPatch(
      { cutoffHour: 99, prepHours: "", maxDays: 0, timezone: "Asia/Manilla" },
      SLOTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors).sort()).toEqual([
        "cutoffHour",
        "maxDays",
        "prepHours",
        "timezone",
      ]);
    }
  });

  it("enforces the locked bounds (prep ≤ 72, window ≤ 120)", () => {
    const tooBig = validateScheduleRulesPatch({ prepHours: 73, maxDays: 121 }, SLOTS);
    expect(tooBig.ok).toBe(false);
    const atBound = validateScheduleRulesPatch({ prepHours: 72, maxDays: 120 }, SLOTS);
    expect(atBound.ok).toBe(true);
  });

  it("rejects duplicate slot values (normalized) and duplicate labels", () => {
    const dupValue = validateScheduleRulesPatch(
      { slots: [{ display: "A", value: "9AM-12PM" }, { display: "B", value: "9am - 12pm" }] },
      [],
    );
    expect(dupValue.ok).toBe(false);

    const dupLabel = validateScheduleRulesPatch(
      { slots: [{ display: "Morning", value: "9AM-12PM" }, { display: "morning", value: "3PM-6PM" }] },
      [],
    );
    expect(dupLabel.ok).toBe(false);
  });

  it("rejects slots missing a label or value", () => {
    const result = validateScheduleRulesPatch(
      { slots: [{ display: "", value: "9AM-12PM" }] },
      [],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects impossible calendar dates in every date-keyed field", () => {
    expect(
      validateScheduleRulesPatch({ disabledDates: ["2026-02-31"] }, SLOTS).ok,
    ).toBe(false);
    expect(
      validateScheduleRulesPatch(
        { disabledSlots: { "2026-13-01": ["9AM-12PM"] } },
        SLOTS,
      ).ok,
    ).toBe(false);
    expect(
      validateScheduleRulesPatch(
        { slotCapacity: { "2026-02-30": { "9AM-12PM": { capacity: 1, booked: 0 } } } },
        SLOTS,
      ).ok,
    ).toBe(false);
  });

  it("rejects orphan slot references instead of persisting them", () => {
    expect(
      validateScheduleRulesPatch(
        { disabledSlots: { "2026-07-22": ["6PM-11PM"] } },
        SLOTS,
      ).ok,
    ).toBe(false);
    expect(
      validateScheduleRulesPatch(
        { slotCapacity: { "2026-07-22": { "6PM-11PM": { capacity: 1, booked: 0 } } } },
        SLOTS,
      ).ok,
    ).toBe(false);
  });

  it("cross-checks against the patch's own slots when both are provided", () => {
    const result = validateScheduleRulesPatch(
      {
        slots: [{ display: "Evening", value: "6PM-11PM" }],
        disabledSlots: { "2026-07-22": ["6pm - 11pm"] }, // tolerant reference
      },
      SLOTS,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects negative and fractional capacities", () => {
    expect(
      validateScheduleRulesPatch(
        { slotCapacity: { "2026-07-22": { "9AM-12PM": { capacity: -1, booked: 0 } } } },
        SLOTS,
      ).ok,
    ).toBe(false);
    expect(
      validateScheduleRulesPatch(
        { slotCapacity: { "2026-07-22": { "9AM-12PM": { capacity: 1.5, booked: 0 } } } },
        SLOTS,
      ).ok,
    ).toBe(false);
  });
});

function storedRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slotsJson: JSON.stringify(SLOTS),
    disabledDatesJson: "[]",
    disabledSlotsJson: "{}",
    slotCapacityJson: "{}",
    ...overrides,
  } as Parameters<typeof deserializeStoredScheduleRules>[0];
}

describe("deserializeStoredScheduleRules — lenient-but-loud read (DEF-10)", () => {
  it("reads a clean record with zero health issues", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(storedRecord());
    expect(configHealth).toEqual([]);
    expect(rules.slots).toEqual(SLOTS);
  });

  it("falls back to default slots on corrupt JSON — but reports it", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({ slotsJson: "{corrupt" }),
    );
    expect(rules.slots).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES.slots);
    expect(configHealth.some((issue) => issue.column === "slotsJson")).toBe(true);
  });

  it("respects a valid, deliberately empty slots list (no default resurrection)", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({ slotsJson: "[]" }),
    );
    expect(rules.slots).toEqual([]);
    expect(configHealth).toEqual([]);
  });

  it("keeps a capacity limit whose stored booked field is missing (no silent destruction)", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({
        slotCapacityJson: JSON.stringify({ "2026-07-20": { "9AM-12PM": { capacity: 5 } } }),
      }),
    );
    expect(rules.slotCapacity).toEqual({
      "2026-07-20": { "9AM-12PM": { capacity: 5, booked: 0 } },
    });
    expect(configHealth).toEqual([]);
  });

  it("replaces an invalid stored timezone with the default and reports it", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({ timezone: "Asia/Manilla" }),
    );
    expect(rules.timezone).toBe("Asia/Manila");
    expect(configHealth.some((issue) => issue.column === "timezone")).toBe(true);
  });

  it("clamps out-of-bounds stored integers and reports it", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({ prepHours: 100000, maxDays: 100000 }),
    );
    expect(rules.prepHours).toBe(72);
    expect(rules.maxDays).toBe(120);
    expect(configHealth.length).toBe(2);
  });

  it("drops malformed stored dates with a health note instead of silently", () => {
    const { rules, configHealth } = deserializeStoredScheduleRules(
      storedRecord({ disabledDatesJson: JSON.stringify(["2026-07-20", "2026-02-31", 42]) }),
    );
    expect(rules.disabledDates).toEqual(["2026-07-20"]);
    expect(
      configHealth.filter((issue) => issue.column === "disabledDatesJson").length,
    ).toBe(2);
  });
});
