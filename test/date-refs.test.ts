import { describe, expect, it } from "vitest";

import { computeDateRefs, enumerateISODates } from "../app/lib/date-refs";

// Shared by the loader's server-side date-tag terms and the client's page
// filter — pinned so the two can never disagree about "tomorrow"/"this week".
describe("computeDateRefs", () => {
  it("uses a Sunday-through-Saturday calendar week (the 2026-07-12 Sunday case)", () => {
    expect(computeDateRefs("2026-07-12")).toEqual({
      todayISO: "2026-07-12",
      tomorrowISO: "2026-07-13",
      startWeekISO: "2026-07-12",
      endWeekISO: "2026-07-18",
    });
  });

  it("anchors a mid-week day to the surrounding Sunday and Saturday, across a month boundary", () => {
    // Thu Sep 4 2026 → Sun Aug 30 .. Sat Sep 5
    expect(computeDateRefs("2026-09-04")).toEqual({
      todayISO: "2026-09-04",
      tomorrowISO: "2026-09-05",
      startWeekISO: "2026-08-30",
      endWeekISO: "2026-09-05",
    });
  });

  it("rolls tomorrow over a year boundary", () => {
    expect(computeDateRefs("2026-12-31").tomorrowISO).toBe("2027-01-01");
  });

  it("collapses an unusable today onto itself instead of producing NaN dates", () => {
    expect(computeDateRefs("nope")).toEqual({
      todayISO: "nope",
      tomorrowISO: "nope",
      startWeekISO: "nope",
      endWeekISO: "nope",
    });
  });
});

describe("enumerateISODates", () => {
  it("lists every day of the week inclusive", () => {
    expect(enumerateISODates("2026-08-30", "2026-09-05")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });

  it("returns a single day for equal bounds and nothing for reversed or bad bounds", () => {
    expect(enumerateISODates("2026-09-05", "2026-09-05")).toEqual(["2026-09-05"]);
    expect(enumerateISODates("2026-09-06", "2026-09-05")).toEqual([]);
    expect(enumerateISODates("x", "2026-09-05")).toEqual([]);
  });

  it("caps a runaway range", () => {
    expect(enumerateISODates("2026-01-01", "2026-12-31")).toHaveLength(31);
  });
});
