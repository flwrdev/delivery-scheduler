import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rulesMock, adminMock } = vi.hoisted(() => ({
  rulesMock: vi.fn(),
  adminMock: vi.fn(),
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesWithBookedCounts: rulesMock,
}));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";
import {
  getAvailableDeliverySlots,
  MESSENGER_AGENT_TOOLS,
  resolveDeliveryDate,
} from "../app/services/messenger-agent-tools.server";

// 2026-08-01T04:00:00Z = Saturday Aug 1, 2026, 12:00 noon in Asia/Manila.
const NOW_MANILA_NOON_SAT = new Date("2026-08-01T04:00:00Z");

describe("MESSENGER_AGENT_TOOLS registry", () => {
  it("exposes exactly resolve_date and get_available_slots", () => {
    expect(MESSENGER_AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "get_available_slots",
      "resolve_date",
    ]);
    for (const tool of MESSENGER_AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("resolveDeliveryDate (Asia/Manila arithmetic — the LLM never computes dates)", () => {
  it("resolves today with the weekday", () => {
    const result = resolveDeliveryDate({ base: "today" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({
      ok: true,
      isoDate: "2026-08-01",
      weekday: "Saturday",
      weekdayFil: "Sabado",
    });
  });

  it("resolves tomorrow", () => {
    const result = resolveDeliveryDate({ base: "tomorrow" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({ ok: true, isoDate: "2026-08-02", weekday: "Sunday" });
  });

  it("uses Manila for the UTC-evening rollover (11PM Manila is still yesterday in UTC)", () => {
    // 2026-08-01T18:00:00Z = Aug 2, 2:00 AM in Manila.
    const result = resolveDeliveryDate({ base: "today" }, new Date("2026-08-01T18:00:00Z"));
    expect(result).toMatchObject({ ok: true, isoDate: "2026-08-02" });
  });

  it("resolves the NEXT occurrence of a weekday (1-7 days ahead)", () => {
    const friday = resolveDeliveryDate(
      { base: "weekday", weekday: "friday" },
      NOW_MANILA_NOON_SAT,
    );
    expect(friday).toMatchObject({ ok: true, isoDate: "2026-08-07", weekday: "Friday" });

    // Asking for Saturday ON a Saturday means next week, never today.
    const saturday = resolveDeliveryDate(
      { base: "weekday", weekday: "saturday" },
      NOW_MANILA_NOON_SAT,
    );
    expect(saturday).toMatchObject({ ok: true, isoDate: "2026-08-08" });
  });

  it("resolves an explicit month/day to this year when still upcoming", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 12, day: 24 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2026-12-24", weekday: "Thursday" });
  });

  it("rolls an already-past explicit month/day to next year", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 1, day: 5 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2027-01-05" });
  });

  it("respects an explicit year", () => {
    const result = resolveDeliveryDate(
      { base: "explicit", month: 2, day: 14, year: 2027 },
      NOW_MANILA_NOON_SAT,
    );
    expect(result).toMatchObject({ ok: true, isoDate: "2027-02-14" });
  });

  it("rejects impossible calendar dates", () => {
    expect(resolveDeliveryDate({ base: "explicit", month: 2, day: 30 }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "explicit", month: 13, day: 1 }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "weekday" }, NOW_MANILA_NOON_SAT).ok).toBe(false);
    expect(resolveDeliveryDate({ base: "explicit" }, NOW_MANILA_NOON_SAT).ok).toBe(false);
  });
});

describe("getAvailableDeliverySlots (direct scheduler call — same engine as the storefront)", () => {
  const RULES = {
    ...DEFAULT_DELIVERY_SCHEDULE_RULES,
    disabledDates: ["2026-08-03"],
  };

  beforeEach(() => {
    vi.stubEnv("MESSENGER_SHOP", "hsrwva-nr.myshopify.com");
    rulesMock.mockResolvedValue(RULES);
    adminMock.mockResolvedValue({ admin: { graphql: vi.fn() } });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns not-configured when MESSENGER_SHOP is missing", async () => {
    vi.stubEnv("MESSENGER_SHOP", "");
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
    expect(rulesMock).not.toHaveBeenCalled();
  });

  it("returns the open slots for a selectable date", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result).toMatchObject({ ok: true, date: "2026-08-02", available: true });
    if (result.ok && result.available) {
      expect(result.slots.map((s) => s.value)).toEqual([
        "9AM-12PM",
        "12PM-3PM",
        "3PM-6PM",
        "6PM-11PM",
      ]);
      expect(result.weekday).toBe("Sunday");
    }
    expect(rulesMock).toHaveBeenCalledWith("hsrwva-nr.myshopify.com", expect.anything());
  });

  it("reports a blocked date with the nearest available dates instead", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-08-03" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.nearestAvailableDates.length).toBeGreaterThan(0);
        expect(result.nearestAvailableDates).not.toContain("2026-08-03");
        expect(result.nearestAvailableDates[0].date >= "2026-08-01").toBe(true);
      }
    }
  });

  it("reports an out-of-window past date as unavailable", async () => {
    const result = await getAvailableDeliverySlots({ date: "2026-07-01" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.available).toBe(false);
    }
  });

  it("rejects a malformed date string", async () => {
    const result = await getAvailableDeliverySlots({ date: "bukas" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
  });

  it("still answers (without live counts) when the offline session/admin client fails", async () => {
    adminMock.mockRejectedValue(new Error("no offline session"));
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(true);
    expect(rulesMock).toHaveBeenCalledWith("hsrwva-nr.myshopify.com", undefined);
  });

  it("never throws when the rules service fails", async () => {
    rulesMock.mockRejectedValue(new Error("db down"));
    const result = await getAvailableDeliverySlots({ date: "2026-08-02" }, NOW_MANILA_NOON_SAT);
    expect(result.ok).toBe(false);
  });
});
