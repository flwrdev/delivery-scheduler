import { describe, expect, it } from "vitest";

// Occasion detection is deterministic keyword matching — no LLM, no I/O.
// Pins the keyword families, source precedence, the excerpt cap, and the
// Feb-29 handling that feeds the yearly roll-forward.

import {
  addDaysISO,
  CARD_MESSAGE_EXCERPT_MAX,
  detectOccasion,
  excerptCardMessage,
  isSameOccasionDate,
  nextOccurrence,
} from "../app/services/occasion-detection.server";

describe("detectOccasion", () => {
  it("detects anniversary keywords in the card message", () => {
    expect(detectOccasion("Happy Anniversary mahal!", null)).toMatchObject({
      type: "anniversary",
      source: "card_message",
    });
    expect(detectOccasion("happy 5th anniv!!", null)).toMatchObject({
      type: "anniversary",
    });
  });

  it("detects birthday keywords incl. Taglish shorthand", () => {
    expect(detectOccasion("Happy Birthday Ma!", null)).toMatchObject({
      type: "birthday",
      source: "card_message",
    });
    expect(detectOccasion("HBD bestie!", null)).toMatchObject({ type: "birthday" });
    expect(detectOccasion("happy bday!! belated na pero love pa rin", null)).toMatchObject({
      type: "birthday",
    });
  });

  it("maps monthsary to 'other' (monthly, not yearly)", () => {
    expect(detectOccasion("happy monthsary us", null)).toMatchObject({ type: "other" });
  });

  it("requires word boundaries — no substring hits", () => {
    // "bday" buried inside another word must not match.
    expect(detectOccasion("bought at Cebday store", null)).toBeNull();
    expect(detectOccasion("scanniversary", null)).toBeNull();
  });

  it("prefers the card message over the order note", () => {
    expect(detectOccasion("Happy Birthday!", "anniversary gift")).toMatchObject({
      type: "birthday",
      source: "card_message",
    });
  });

  it("falls back to the order note, then null", () => {
    expect(detectOccasion(null, "for their anniversary")).toMatchObject({
      type: "anniversary",
      source: "order_note",
    });
    expect(detectOccasion("get well soon", "rush order")).toBeNull();
    expect(detectOccasion(null, null)).toBeNull();
  });
});

describe("excerptCardMessage", () => {
  it("collapses whitespace and caps the length", () => {
    expect(excerptCardMessage("Happy\n  Anniversary!\n\nLove you")).toBe(
      "Happy Anniversary! Love you",
    );
    const long = "a".repeat(500);
    const excerpt = excerptCardMessage(long)!;
    expect(excerpt.length).toBeLessThanOrEqual(CARD_MESSAGE_EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("returns null for empty input", () => {
    expect(excerptCardMessage("   ")).toBeNull();
    expect(excerptCardMessage(null)).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("returns this year's date when it is still ahead", () => {
    expect(nextOccurrence("2025-08-28", "2026-08-21")).toEqual({
      date: "2026-08-28",
      year: 2026,
    });
  });

  it("rolls to next year when the date already passed", () => {
    expect(nextOccurrence("2025-08-10", "2026-08-21")).toEqual({
      date: "2027-08-10",
      year: 2027,
    });
  });

  it("lands Feb 29 on Feb 28 in non-leap years", () => {
    expect(nextOccurrence("2024-02-29", "2026-01-01")).toEqual({
      date: "2026-02-28",
      year: 2026,
    });
  });

  it("rejects malformed dates", () => {
    expect(nextOccurrence("garbage", "2026-08-21")).toBeNull();
  });
});

describe("date helpers", () => {
  it("addDaysISO crosses month boundaries", () => {
    expect(addDaysISO("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("isSameOccasionDate tolerates ±2 days", () => {
    expect(isSameOccasionDate("2026-08-28", "2026-08-30")).toBe(true);
    expect(isSameOccasionDate("2026-08-28", "2026-08-31")).toBe(false);
  });
});
