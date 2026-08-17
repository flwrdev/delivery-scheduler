import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { verifyLalamoveWebhookSignature } from "../lib/verify-lalamove-signature.server";
import {
  markLalamoveOrderDelivered,
  mirrorLalamoveOrderStatus,
} from "../services/lalamove-tracking.server";
import { unauthenticated } from "../shopify.server";

// Lalamove Open API webhook — status listener only (ADR-16). NOT a Shopify
// webhook: Lalamove signs it with its own HMAC scheme
// (verify-lalamove-signature.server.ts), never touches authenticate.*.
//
// BEST-EFFORT ONLY, not the primary mechanism (revised 2026-08-16): a live
// test proved Lalamove's push webhooks never fire for orders booked through
// the merchant's manual "Place Order" web flow — confirmed via the Partner
// Portal's own "Webhook attempts" log showing zero order-related events
// across a real driver assignment and cancellation, while an unrelated
// WALLET_BALANCE_CHANGED event delivered fine on the same URL. The fallback
// poller (internal.lalamove-poll.ts) is the mechanism that actually runs in
// practice; this route is kept wired in case Lalamove ever does push
// something for this account, but nothing here should be assumed to fire.
// It can only act on an id already recorded via `recordLalamoveOrderId`
// (the merchant pasting the Lalamove Order ID into the "Mark as fulfilled"
// modal) — it never discovers new correlations itself.
//
// Registered once via lalamove-client.server.ts#configureLalamoveWebhook
// against this route's public URL. Single-shop app (AppDistribution.
// SingleMerchant) — LALAMOVE_SHOP names the one shop this app manages,
// same convention as MESSENGER_SHOP.
//
// Payload shape (eventType/orderId/status field paths) is UNVERIFIED against
// a real delivery as of 2026-08-16 — Lalamove's webhook tutorial PDF is
// image-only and could not be parsed, and no real order-event payload has
// ever been observed (see above). This parses the most likely shape and
// logs the raw payload on anything it can't recognize. See
// docs/known-issues.md.
//
// Always 200 once the signature is valid — Lalamove should never be made to
// retry-storm this app (same posture as every other webhook here).

const PATH = "/webhooks/lalamove-tracking";

function extractEventType(payload: Record<string, unknown>): string | null {
  const v = payload.eventType ?? payload.type;
  return typeof v === "string" ? v : null;
}

function extractOrderIdAndStatus(
  payload: Record<string, unknown>,
): { orderId: string; status: string } | null {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const order = (data.order ?? data) as Record<string, unknown>;
  // Lalamove order ids are purely numeric — a real payload could plausibly
  // encode one as a JSON number rather than a string. Coerce rather than
  // reject, so this doesn't silently drop an otherwise-valid, validly-signed
  // event on top of the already-flagged "payload shape unverified" gap.
  const orderIdRaw = order.orderId ?? order.id;
  const orderId =
    typeof orderIdRaw === "string"
      ? orderIdRaw
      : typeof orderIdRaw === "number"
        ? String(orderIdRaw)
        : null;
  const status = order.status;
  if (orderId && typeof status === "string") {
    return { orderId, status };
  }
  return null;
}

// Lalamove pings the webhook URL with a plain GET before saving it via
// PATCH /v3/webhook (`configureLalamoveWebhook`) — a PATCH otherwise 422s
// with "Non-200 response received" (confirmed live 2026-08-16). No signature
// on this ping (there is nothing to sign yet), so this just confirms
// reachability — it does not verify anything.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  return new Response(null, { status: 200 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const rawBody = await request.text();

  const apiSecret = process.env.LALAMOVE_API_SECRET?.trim();
  if (!apiSecret) {
    console.error("[lalamove-tracking] LALAMOVE_API_SECRET not configured");
    return new Response(null, { status: 401 });
  }

  const authorizationHeader = request.headers.get("authorization");
  // Lalamove's `PATCH /v3/webhook` registration call pings the URL first and
  // 422s the registration unless every ping gets a 2xx back (confirmed live
  // 2026-08-16) — including, apparently, an UNSIGNED verification POST (no
  // Authorization header at all). Treat "no signature attempted" as a
  // harmless no-op 200; only a PRESENT-but-invalid signature is a rejected
  // (401) real attack attempt. No event is ever processed without a valid
  // signature either way.
  if (!authorizationHeader) {
    console.log("[lalamove-tracking] unsigned POST (verification ping?) — 200 no-op");
    return new Response(null, { status: 200 });
  }

  const auth = verifyLalamoveWebhookSignature(
    rawBody,
    "POST",
    PATH,
    authorizationHeader,
    apiSecret,
  );
  if (!auth.ok) {
    console.warn(`[lalamove-tracking] rejected webhook: ${auth.reason}`);
    return new Response(null, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    console.error("[lalamove-tracking] malformed JSON on a validly signed webhook");
    return new Response(null, { status: 200 });
  }

  const eventType = extractEventType(payload);
  const parsed = extractOrderIdAndStatus(payload);
  if (!eventType || !parsed) {
    console.warn(
      "[lalamove-tracking] unrecognized payload shape, logging raw for diagnosis:",
      rawBody,
    );
    return new Response(null, { status: 200 });
  }

  const shop = process.env.LALAMOVE_SHOP?.trim();
  if (!shop) {
    console.error("[lalamove-tracking] LALAMOVE_SHOP not configured");
    return new Response(null, { status: 200 });
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.warn(
      `[lalamove-tracking] no offline session for ${shop} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return new Response(null, { status: 200 });
  }

  if (eventType === "ORDER_STATUS_CHANGED") {
    if (parsed.status === "COMPLETED" || parsed.status === "COMPLETE") {
      const result = await markLalamoveOrderDelivered(admin, parsed.orderId);
      console.log(`[lalamove-tracking] ORDER_STATUS_CHANGED COMPLETE ${parsed.orderId}: ${result.status}`);
    } else {
      await mirrorLalamoveOrderStatus(parsed.orderId, parsed.status);
    }
    return new Response(null, { status: 200 });
  }

  // Other event types (DRIVER_ASSIGNED, ORDER_CREATED, POD_STATUS_CHANGED,
  // ...) — no-op. ORDER_CREATED in particular is never acted on: this route
  // does not discover new correlations, only updates ones already recorded
  // via recordLalamoveOrderId.
  return new Response(null, { status: 200 });
};
