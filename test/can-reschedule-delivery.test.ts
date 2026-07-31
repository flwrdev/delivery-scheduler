import { describe, expect, it } from "vitest";

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  canRescheduleDelivery,
  cloneDeliveryScheduleRules,
} from "../app/lib/delivery-availability";

// Asia/Manila is UTC+8. cutoffHour on the default rules is 17 (5PM Manila).
const MANILA_BEFORE_CUTOFF = new Date("2026-07-31T02:00:00Z"); // 10:00 AM Manila, Jul 31
const MANILA_AFTER_CUTOFF = new Date("2026-07-31T10:00:00Z"); // 6:00 PM Manila, Jul 31

const rules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);

describe("canRescheduleDelivery (config-driven cutoff)", () => {
  it("allows rescheduling when the current delivery date is still bookable (same day, before cutoff)", () => {
    expect(canRescheduleDelivery("2026-07-31", MANILA_BEFORE_CUTOFF, rules)).toBe(
      true,
    );
  });

  it("blocks rescheduling a same-day delivery after the cutoff hour", () => {
    expect(canRescheduleDelivery("2026-07-31", MANILA_AFTER_CUTOFF, rules)).toBe(
      false,
    );
  });

  it("allows rescheduling a next-day delivery even after the cutoff hour", () => {
    expect(canRescheduleDelivery("2026-08-01", MANILA_AFTER_CUTOFF, rules)).toBe(
      true,
    );
  });

  it("blocks rescheduling when the delivery date has already passed", () => {
    expect(canRescheduleDelivery("2026-07-30", MANILA_BEFORE_CUTOFF, rules)).toBe(
      false,
    );
  });

  it("blocks rescheduling for a non-ISO delivery date", () => {
    expect(
      canRescheduleDelivery("July 31, 2026", MANILA_BEFORE_CUTOFF, rules),
    ).toBe(false);
  });

  it("respects a later cutoff hour from the shop's configured rules", () => {
    const lateCutoff = { ...rules, cutoffHour: 20 };
    expect(
      canRescheduleDelivery("2026-07-31", MANILA_AFTER_CUTOFF, lateCutoff),
    ).toBe(true);
  });
});
