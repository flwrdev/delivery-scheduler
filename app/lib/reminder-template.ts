// Reminder template token rendering — deliberately NOT a .server module: the
// /app/reminders editor renders the live preview client-side with the same
// function the send path uses, so preview and reality can never drift.
// (A .server import from the page component is a build error — see the
// status-literal note in app.reminders.tsx.)

export interface ReminderTemplateVars {
  name: string;
  recipient: string;
  occasion: string;
  date: string; // "August 25"
  weekday: string; // "Sabado"
  past_date: string; // "August 25, 2025"
  product: string;
  cutoff: string; // "2 PM"
  discount_code: string;
  discount_label: string;
  store_url: string;
}

export const REMINDER_TEMPLATE_TOKENS: Array<{ token: keyof ReminderTemplateVars; hint: string }> = [
  { token: "name", hint: "pangalan ng bumili (billing → shipping fallback)" },
  { token: "recipient", hint: "pangalan ng padadalhan (shipping name)" },
  { token: "occasion", hint: 'napansing okasyon o "your special day"' },
  { token: "date", hint: "petsa ng okasyon, hal. August 25" },
  { token: "weekday", hint: "araw sa Filipino, hal. Sabado" },
  { token: "past_date", hint: "petsa noong nakaraang taon, hal. August 25, 2025" },
  { token: "product", hint: 'binili noon, hal. Classic Red Roses (o "flowers")' },
  { token: "cutoff", hint: "same-day cutoff mula sa scheduler config, hal. 2 PM" },
  { token: "discount_code", hint: "ANNIV200" },
  { token: "discount_label", hint: "₱200 off" },
  { token: "store_url", hint: "https://flowercart.store" },
];

// Replaces {token} occurrences; unknown tokens are left visible as-is so a
// typo shows up in the preview instead of silently vanishing from the email.
export function renderReminderTemplate(template: string, vars: ReminderTemplateVars): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key as keyof ReminderTemplateVars];
    }
    return whole;
  });
}

// Editor prefill — the token-template equivalent of the built-in drafts in
// reminder-copy.server.ts (the merchant's own wording). Saving these
// unchanged behaves ~identically to leaving the fields blank; the one
// built-in nicety a flat template cannot express is the automatic 7d subject
// switch to "{recipient}'s {occasion} is coming up" kapag kilala ang
// recipient — the editor helptext says so.
export const DEFAULT_TEMPLATE_TEXTS: Record<
  "7d" | "3d",
  { subject: string; body: string }
> = {
  "7d": {
    subject: "A little reminder about {occasion} 🌸",
    body: [
      "Hi {name},",
      "",
      "A little reminder, a little time to prepare.",
      "",
      "It's almost been a year since you sent {product} to {recipient} for {occasion}, and {date} is just a week away.",
      "",
      "If you're thinking of making this year just as special, there's still time. Pick the same bouquet or browse something new at {store_url}.",
      "",
      "Order before {cutoff} for same-day delivery anywhere in Metro Manila.",
      "",
      "Order Now → {store_url}",
    ].join("\n"),
  },
  "3d": {
    subject: "Still time for {occasion}, plus {discount_label}",
    body: [
      "Hi {name},",
      "",
      "A little more time, a little more to celebrate.",
      "",
      "{occasion} is just 3 days away, and we remember {recipient} was on your mind this time last year. If it's still on yours, we've got you covered.",
      "",
      "As a returning customer, use {discount_code} at checkout for {discount_label}.",
      "",
      "Cutoff for same-day delivery is {cutoff}. Order now to make it in time.",
      "",
      "Already placed your order? You're all set, no action needed.",
      "",
      "Order Now → {store_url}",
    ].join("\n"),
  },
};

export const SAMPLE_TEMPLATE_VARS: ReminderTemplateVars = {
  name: "Juan",
  recipient: "Maria",
  occasion: "anniversary",
  date: "August 25",
  weekday: "Martes",
  past_date: "August 25, 2025",
  product: "Classic Red Roses",
  cutoff: "2 PM",
  discount_code: "ANNIV200",
  discount_label: "₱200 off",
  store_url: "https://flowercart.store",
};
