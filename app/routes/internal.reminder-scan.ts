import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

import { runReminderScan, TOUCH_OFFSETS } from "../services/occasion-reminders.server";
import type { ReminderTouch } from "../services/reminder-copy.server";
import { unauthenticated } from "../shopify.server";

// Occasion reminder nightly scan+send — triggered by the Google Cloud
// Scheduler job `delivery-scheduler-reminder-scan` (daily, 21:00 UTC =
// 05:00 Asia/Manila; Cloud Run has no native cron — same pattern as
// internal.lalamove-poll.ts). Auth is a shared-secret header because this
// endpoint is our own.
//
// ZERO Shopify order writes: the scan only runs read-only orders searches;
// everything it mutates is Postgres-side (OccasionReminder /
// ReminderSuppression / EmailSendLog). See docs/api.md — this route sits
// outside the §2 order write-path contract, and the read-only guard test
// greps this file to keep it that way.
//
// The optional JSON body { touchDaysOverride: number[], windowDaysOverride }
// is secret-gated and exists for dev-store dry runs against arbitrary
// windows (e.g. pointing the scan at a backdated test order).

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const scanSecret = process.env.REMINDER_SCAN_SECRET?.trim();
  const provided = request.headers.get("x-reminder-scan-secret")?.trim();
  if (!scanSecret || !provided || !timingSafeEqualStrings(provided, scanSecret)) {
    return new Response(null, { status: 401 });
  }

  const shop = process.env.REMINDER_SHOP?.trim();
  if (!shop) {
    console.error("[reminder-scan] REMINDER_SHOP not configured");
    return Response.json({ ok: false, error: "not configured" }, { status: 200 });
  }

  let touchOffsetsOverride: Array<{ touch: ReminderTouch; days: number }> | undefined;
  let windowDaysOverride: number | undefined;
  try {
    const body = (await request.json()) as {
      touchDaysOverride?: unknown;
      windowDaysOverride?: unknown;
    };
    if (Array.isArray(body.touchDaysOverride)) {
      const days = body.touchDaysOverride
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 60);
      if (days.length > 0 && days.length <= 2) {
        touchOffsetsOverride = days.map((d, i) => ({
          touch: TOUCH_OFFSETS[Math.min(i, TOUCH_OFFSETS.length - 1)].touch,
          days: d,
        }));
      }
    }
    if (Number.isInteger(body.windowDaysOverride)) {
      const w = Number(body.windowDaysOverride);
      if (w >= 1 && w <= 30) windowDaysOverride = w;
    }
  } catch {
    // No/invalid JSON body — the normal Cloud Scheduler case.
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.warn(
      `[reminder-scan] no offline session for ${shop} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return Response.json({ ok: false, error: "no offline session" }, { status: 200 });
  }

  try {
    const summary = await runReminderScan({
      admin,
      shop,
      touchOffsetsOverride,
      windowDaysOverride,
    });
    return Response.json(summary);
  } catch (error) {
    // ADR-11: upstream failures answer 200 + ok:false, never 5xx.
    console.warn(
      `[reminder-scan] run threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json({ ok: false, error: "scan failed" }, { status: 200 });
  }
};
