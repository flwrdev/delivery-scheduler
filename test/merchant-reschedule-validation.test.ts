import { describe, expect, it } from "vitest";

import {
  validateMerchantRescheduleSelection,
  type DeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// §5 validation matrix (locked 2026-07-11): merchant reschedule is an
// administrative override — only data-integrity checks bind it. These tests
// pin both halves: the hard checks AND the deliberate absence of the
// customer-facing date-window / capacity gates.

const rules: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "3PM-6PM", value: "3PM-6PM" },
  ],
  disabledDates: ["2026-07-21"],
  disabledSlots: { "2026-07-22": ["3PM-6PM"] },
  slotCapacity: {
    "2026-07-20": { "3PM-6PM": { capacity: 5, booked: 5 } },
  },
};

describe("validateMerchantRescheduleSelection — hard data-integrity checks", () => {
  it("rejects a malformed date", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "07/20/2026",
      "3PM-6PM",
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_date" });
  });

  it("rejects a slot value that is neither configured nor a time", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-20",
      "evening",
    );
    expect(result).toMatchObject({ ok: false, code: "slot_unknown" });
  });

  it("rejects a blocked date before looking at the slot", () => {
    const result = validateMerchantRescheduleSelection(rules, "2026-07-21", "8PM");
    expect(result).toMatchObject({ ok: false, code: "date_blocked" });
  });

  it("rejects a blocked date", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-21",
      "3PM-6PM",
    );
    expect(result).toMatchObject({ ok: false, code: "date_blocked" });
  });

  it("rejects a blocked slot on its blocked date only", () => {
    expect(
      validateMerchantRescheduleSelection(rules, "2026-07-22", "3PM-6PM"),
    ).toMatchObject({ ok: false, code: "slot_blocked" });
    expect(
      validateMerchantRescheduleSelection(rules, "2026-07-22", "9AM-12PM").ok,
    ).toBe(true);
  });
});

describe("validateMerchantRescheduleSelection — administrative override", () => {
  it("passes a full slot and reports its capacity (warn+override, not a gate)", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-20",
      "3PM-6PM",
    );
    expect(result).toEqual({
      ok: true,
      slotValue: "3PM-6PM",
      customTime: false,
      capacity: { capacity: 5, booked: 5 },
    });
  });

  it("returns null capacity when none is configured for the date+slot", () => {
    const result = validateMerchantRescheduleSelection(
      rules,
      "2026-07-23",
      "9AM-12PM",
    );
    expect(result).toEqual({
      ok: true,
      slotValue: "9AM-12PM",
      customTime: false,
      capacity: null,
    });
  });

  it("skips the customer date window entirely: past dates and dates beyond maxDays pass", () => {
    expect(
      validateMerchantRescheduleSelection(rules, "2020-01-01", "9AM-12PM").ok,
    ).toBe(true);
    expect(
      validateMerchantRescheduleSelection(rules, "2030-12-31", "9AM-12PM").ok,
    ).toBe(true);
  });
});

describe("validateMerchantRescheduleSelection — merchant-typed custom time", () => {
  it("accepts a single time that is not a configured slot and canonicalizes it", () => {
    expect(validateMerchantRescheduleSelection(rules, "2026-07-20", "8:00 pm")).toEqual({
      ok: true,
      slotValue: "8PM",
      customTime: true,
      capacity: null,
    });
  });

  it("accepts a time range that is not a configured slot", () => {
    expect(validateMerchantRescheduleSelection(rules, "2026-07-20", "8pm - 9:30pm")).toEqual({
      ok: true,
      slotValue: "8PM-9:30PM",
      customTime: true,
      capacity: null,
    });
  });

  it("still resolves a configured slot before treating the input as custom", () => {
    expect(validateMerchantRescheduleSelection(rules, "2026-07-20", "3pm - 6pm")).toMatchObject({
      ok: true,
      slotValue: "3PM-6PM",
      customTime: false,
    });
  });

  it("rejects malformed times", () => {
    for (const bad of ["25PM", "8", "8PM-", "8PM-9PM-10PM", "8:60PM"]) {
      expect(validateMerchantRescheduleSelection(rules, "2026-07-20", bad)).toMatchObject({
        ok: false,
        code: "slot_unknown",
      });
    }
  });
});
