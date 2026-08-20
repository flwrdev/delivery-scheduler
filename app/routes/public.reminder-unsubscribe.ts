import type { LoaderFunctionArgs } from "react-router";

import {
  recordSuppression,
  verifyUnsubscribeToken,
} from "../services/occasion-reminders.server";

// Reminder unsubscribe — a plain GET clicked from the reminder email's
// footer; the signed HMAC token IS the auth (no session, no origin check —
// same public posture as public.customer-account.*, minus the JWT because
// the reader is an email client, not an extension).
//
// Zero Shopify writes: a valid token upserts a ReminderSuppression row and
// flips any still-PENDING OccasionReminder rows for that email to
// SUPPRESSED — Postgres only. Invalid/missing tokens get the SAME generic
// 200 page as success (no enumeration oracle: the page never confirms
// whether an email was subscribed). Never 5xx (ADR-11 — Cloudflare replaces
// 5xx bodies).

const SHOP_ENV = "REMINDER_SHOP";

function htmlPage(heading: string, detail: string): Response {
  const html = `<!doctype html>
<html lang="tl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Flowercart Reminders</title>
<style>
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: #faf7f5; color: #3b3230;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #ffffff; border: 1px solid #e9ded9; border-radius: 10px; padding: 40px 44px;
          max-width: 420px; margin: 24px; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 12px; color: #9a6a60; }
  p { font-size: 0.95rem; line-height: 1.6; margin: 0; }
  .brand { margin-top: 28px; font-size: 0.8rem; color: #a89a94; letter-spacing: 0.08em; }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${detail}</p>
    <div class="brand">THE FLOWERCART</div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const genericPage = htmlPage(
    "Okay, tapos na.",
    "Hindi ka na makakatanggap ng paalala para dito. Kung nagbago ang isip mo, " +
      "mag-email lang sa jhay@flowercart.store at ibabalik namin.",
  );

  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim();
  if (!token) return genericPage;

  const payload = verifyUnsubscribeToken(token);
  if (!payload) return genericPage;

  const shop = process.env[SHOP_ENV]?.trim();
  if (!shop) {
    console.warn("[reminder-unsubscribe] REMINDER_SHOP not configured");
    return genericPage;
  }

  try {
    await recordSuppression(shop, payload.email, payload.scope, "unsubscribe_link");
  } catch (error) {
    // Still show the generic page — the customer clicked unsubscribe; a
    // transient DB error must not read as "something went wrong, try again"
    // spam-bait. The suppression is re-checked at every send anyway, and the
    // customer can click the same link again.
    console.warn(
      `[reminder-unsubscribe] suppression write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return genericPage;
};
