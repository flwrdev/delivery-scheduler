// Reminder email copy — the single place the occasion-reminder wording lives.
// The wording is the MERCHANT'S OWN template, pulled verbatim from his
// "flowercart-reminder-email-sequence.md" (Google Drive, 2026-08-21) — do not
// rewrite it, only fill the variables. Plain text only (locked decision E-6
// in docs/customer-email-design.md), so:
//   - "preview text" from the template is not used (plain text has no
//     preview field; the first body line serves that role in inboxes)
//   - the [Order Now →] button renders as a plain "Order Now → <url>" line
// Variable fallbacks (merchant decision 2026-08-21, "fallback words"):
//   [Occasion]  → "your special day" when no keyword was detected
//   [recipient] → "someone special" when the shipping name is unusable
//   [product]   → "flowers" when line-item titles are missing
// Name sourcing (merchant decision 2026-08-21): greeting = billing name,
// fallback shipping name; recipient = shipping/delivery name from the order
// details — NEVER parsed out of the card message (~70% failure measured).

export const REMINDER_DISCOUNT_CODE = "ANNIV200";
export const REMINDER_DISCOUNT_LABEL = "₱200 off";
export const STORE_URL = "https://flowercart.store";

const OCCASION_FALLBACK = "your special day";
const RECIPIENT_FALLBACK = "someone special";
const PRODUCT_FALLBACK = "flowers";

export type ReminderTouch = "7d" | "3d";

export interface ReminderDraftInput {
  touch: ReminderTouch;
  occasionType: string; // "anniversary" | "birthday" | "other" | "generic"
  occasionDate: string; // ISO YYYY-MM-DD (the upcoming occurrence)
  customerFirstName: string | null; // billing-first resolved greeting name
  recipientName: string | null; // shipping/delivery name from order details
  productTitles: string | null;
  cutoffHour: number; // from live DeliveryScheduleConfig — never hardcode
}

export interface ReminderDraft {
  subject: string;
  body: string; // WITHOUT the footer — appendReminderFooter is mandatory
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseISO(dateISO: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// "August 25" — no year (the reader knows which year is coming).
export function formatMonthDay(dateISO: string): string {
  const parts = parseISO(dateISO);
  if (!parts) return dateISO;
  return `${MONTHS[parts.month - 1]} ${parts.day}`;
}

// cutoffHour 14 → "2 PM" (brand voice: the real cutoff, from live config).
export function formatCutoffLabel(cutoffHour: number): string {
  const hour = Number.isInteger(cutoffHour) && cutoffHour >= 0 && cutoffHour <= 23 ? cutoffHour : 14;
  if (hour === 0) return "12 midnight";
  if (hour === 12) return "12 noon";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// [Occasion] — capitalized where the template capitalizes it mid-sentence
// reads fine lowercased, so we keep it lowercase and let sentence position
// carry the casing, matching how "anniversary"/"birthday" appear naturally.
function occasionText(occasionType: string): string {
  if (occasionType === "anniversary") return "anniversary";
  if (occasionType === "birthday") return "birthday";
  return OCCASION_FALLBACK; // "other" | "generic"
}

export function buildReminderDraft(input: ReminderDraftInput): ReminderDraft {
  const monthDay = formatMonthDay(input.occasionDate);
  const occasion = occasionText(input.occasionType);
  const occasionKnown = input.occasionType === "anniversary" || input.occasionType === "birthday";
  const hi = input.customerFirstName ? `Hi ${input.customerFirstName},` : "Hi,";
  const recipient = input.recipientName?.trim() || RECIPIENT_FALLBACK;
  const product = input.productTitles?.trim() || PRODUCT_FALLBACK;
  const cutoff = formatCutoffLabel(input.cutoffHour);

  if (input.touch === "7d") {
    // Subject: template option 2 when the recipient is a real name AND the
    // occasion was detected; otherwise option 1 with the occasion fallback.
    const subject =
      recipient !== RECIPIENT_FALLBACK && occasionKnown
        ? `${recipient}'s ${occasion} is coming up`
        : `A little reminder about ${occasion} 🌸`;

    const body = [
      hi,
      "",
      "A little reminder, a little time to prepare.",
      "",
      `It's almost been a year since you sent ${product} to ${recipient} for ` +
        `${occasion}, and ${monthDay} is just a week away.`,
      "",
      `If you're thinking of making this year just as special, there's still ` +
        `time. Pick the same bouquet or browse something new at ${STORE_URL}.`,
      "",
      `Order before ${cutoff} for same-day delivery anywhere in Metro Manila.`,
      "",
      `Order Now → ${STORE_URL}`,
    ].join("\n");

    return { subject, body };
  }

  // 3d — template option 2 ("Still time for [Occasion], plus [DISCOUNT_LABEL]").
  const subject = `Still time for ${occasion}, plus ${REMINDER_DISCOUNT_LABEL}`;

  const body = [
    hi,
    "",
    "A little more time, a little more to celebrate.",
    "",
    `${capitalizeFirst(occasion)} is just 3 days away, and we remember ` +
      `${recipient} was on your mind this time last year. If it's still on ` +
      `yours, we've got you covered.`,
    "",
    `As a returning customer, use ${REMINDER_DISCOUNT_CODE} at checkout for ` +
      `${REMINDER_DISCOUNT_LABEL}.`,
    "",
    `Cutoff for same-day delivery is ${cutoff}. Order now to make it in time.`,
    "",
    `Already placed your order? You're all set, no action needed.`,
    "",
    `Order Now → ${STORE_URL}`,
  ].join("\n");

  return { subject, body };
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Mandatory footer (merchant's template, both emails) — the send path appends
// this after building the draft so the unsubscribe link can never be dropped.
export function appendReminderFooter(body: string, unsubscribeUrl: string): string {
  const year = new Date().getFullYear();
  return [
    body,
    "",
    "—",
    "The Flowercart · 255 Kawit St, Manila · 09624224085 · jhay@flowercart.store",
    "",
    `No longer want to receive these emails? Unsubscribe: ${unsubscribeUrl}`,
    "",
    `© ${year} The Flowercart`,
  ].join("\n");
}
