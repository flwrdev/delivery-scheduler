import { describe, expect, it } from "vitest";

// Shared (non-.server) template renderer — the same function drives the
// /app/reminders live preview AND the real send path, pinned here so the two
// can never disagree.

import {
  DEFAULT_TEMPLATE_TEXTS,
  renderReminderTemplate,
  SAMPLE_TEMPLATE_VARS,
} from "../app/lib/reminder-template";

describe("renderReminderTemplate", () => {
  it("replaces every known token", () => {
    const out = renderReminderTemplate(
      "Hi {name}, para kay {recipient}: {occasion} sa {date} ({weekday}). " +
        "Last year: {past_date}, {product}. Cutoff {cutoff}. {discount_code} = {discount_label}. {store_url}",
      SAMPLE_TEMPLATE_VARS,
    );
    expect(out).toBe(
      "Hi Juan, para kay Maria: anniversary sa August 25 (Martes). " +
        "Last year: August 25, 2025, Classic Red Roses. Cutoff 2 PM. ANNIV200 = ₱200 off. https://flowercart.store",
    );
  });

  it("leaves unknown tokens visible instead of silently dropping them", () => {
    expect(renderReminderTemplate("Hi {name}, {typo_token}!", SAMPLE_TEMPLATE_VARS)).toBe(
      "Hi Juan, {typo_token}!",
    );
  });

  it("default template texts render clean with the sample vars", () => {
    for (const touch of ["7d", "3d"] as const) {
      const subject = renderReminderTemplate(DEFAULT_TEMPLATE_TEXTS[touch].subject, SAMPLE_TEMPLATE_VARS);
      const body = renderReminderTemplate(DEFAULT_TEMPLATE_TEXTS[touch].body, SAMPLE_TEMPLATE_VARS);
      expect(subject).not.toMatch(/\{[a-z_]+\}/);
      expect(body).not.toMatch(/\{[a-z_]+\}/);
    }
  });
});
