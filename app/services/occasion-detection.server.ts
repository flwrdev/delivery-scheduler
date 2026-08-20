// Occasion detection for the reminder emails — pure functions, no I/O, no
// LLM: a deterministic keyword pass over the checkout card message / order
// note. Detection only personalizes the copy ("ang anniversary" vs the
// generic "isang taon na"); a miss never gates the reminder itself (merchant
// decision 2026-08-21: ALL orders enter the occasion calendar).

export type OccasionType = "anniversary" | "birthday" | "other" | "generic";
export type DetectSource = "card_message" | "order_note" | "none";

export interface OccasionDetection {
  type: Exclude<OccasionType, "generic">;
  source: Exclude<DetectSource, "none">;
  matchedKeyword: string;
}

export const CARD_MESSAGE_EXCERPT_MAX = 140;

// Word-boundary keyword table. Order matters within a family only for which
// keyword gets reported back; the family decides the type. "monthsary"
// recurs monthly, not yearly, so it maps to "other" — the +1-year framing is
// still valid ("isang taon mula nang batiin mo siya") but copy stays generic
// about the occasion name.
const KEYWORD_FAMILIES: Array<{ type: OccasionDetection["type"]; keywords: string[] }> = [
  { type: "anniversary", keywords: ["anniversary", "anniv", "happy anniv"] },
  { type: "birthday", keywords: ["birthday", "bday", "hbd", "happy bday", "belated"] },
  { type: "other", keywords: ["monthsary"] },
];

function findKeyword(text: string): { type: OccasionDetection["type"]; matchedKeyword: string } | null {
  const haystack = text.toLowerCase();
  for (const family of KEYWORD_FAMILIES) {
    for (const keyword of family.keywords) {
      // \b works here because every keyword is ASCII-word-shaped.
      const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, "\\s+")}\\b`, "i");
      if (pattern.test(haystack)) {
        return { type: family.type, matchedKeyword: keyword };
      }
    }
  }
  return null;
}

export function detectOccasion(
  cardMessage: string | null | undefined,
  orderNote: string | null | undefined,
): OccasionDetection | null {
  const card = (cardMessage ?? "").trim();
  if (card) {
    const hit = findKeyword(card);
    if (hit) return { ...hit, source: "card_message" };
  }
  const note = (orderNote ?? "").trim();
  if (note) {
    const hit = findKeyword(note);
    if (hit) return { ...hit, source: "order_note" };
  }
  return null;
}

// NOTE deliberately NO card-message recipient parsing: the merchant measured
// it at ~70% failure on real card messages (2026-08-21). The recipient name
// comes from the order's shipping address instead — resolved at scan time in
// occasion-reminders.server.ts, not here.

export function excerptCardMessage(cardMessage: string | null | undefined): string | null {
  const collapsed = (cardMessage ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > CARD_MESSAGE_EXCERPT_MAX
    ? `${collapsed.slice(0, CARD_MESSAGE_EXCERPT_MAX - 1)}…`
    : collapsed;
}

// Next yearly occurrence of a past occasion date, relative to "today" in the
// shop's timezone. Feb 29 anniversaries land on Feb 28 in non-leap years.
export function nextOccurrence(
  pastDateISO: string,
  todayISO: string,
): { date: string; year: number } | null {
  const pastMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pastDateISO);
  const todayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayISO);
  if (!pastMatch || !todayMatch) return null;

  const [, , pastMonth, pastDay] = pastMatch;
  const todayYear = Number(todayMatch[1]);

  const candidate = (year: number): string => {
    let day = Number(pastDay);
    if (pastMonth === "02" && day === 29 && !isLeapYear(year)) day = 28;
    return `${year}-${pastMonth}-${String(day).padStart(2, "0")}`;
  };

  // The first occurrence on or after today.
  const thisYear = candidate(todayYear);
  if (thisYear >= todayISO) return { date: thisYear, year: todayYear };
  return { date: candidate(todayYear + 1), year: todayYear + 1 };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// ISO date arithmetic without timezone pitfalls: treat dates as UTC noon.
export function addDaysISO(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Month-day proximity for cross-source dedupe: same email + occasion dates
// within ±toleranceDays = the same occasion, however many orders back it.
export function isSameOccasionDate(aISO: string, bISO: string, toleranceDays = 2): boolean {
  const [ay, am, ad] = aISO.split("-").map(Number);
  const [by, bm, bd] = bISO.split("-").map(Number);
  if (!ay || !by) return false;
  const a = Date.UTC(ay, am - 1, ad, 12);
  const b = Date.UTC(by, bm - 1, bd, 12);
  return Math.abs(a - b) <= toleranceDays * 24 * 60 * 60 * 1000;
}
