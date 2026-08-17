// Lalamove courier-status listener (ADR-16 — status-listen, NOT dispatch;
// dispatch stays 100% in the merchant's manual web.lalamove.com booking,
// untouched by this app per ADR-1).
//
// POLLING-ONLY design (revised 2026-08-16 after a live test proved the
// webhook path unusable — see the ADR-16 addendum in decisions.md):
// Lalamove's push webhooks (ORDER_CREATED, ORDER_STATUS_CHANGED, etc.) never
// fired for a real delivery booked through the merchant's manual "Place
// Order" web flow — confirmed live: a driver assignment and a cancellation
// on a real order produced ZERO webhook attempts in the Lalamove Partner
// Portal's own "Webhook attempts" log, even though the same URL/credentials
// correctly received unrelated WALLET_BALANCE_CHANGED events. Direct
// `getOrderStatus(orderId)` reads, by contrast, work fine for ANY order on
// the account regardless of how it was booked (also confirmed live). The
// webhook route is kept wired (harmless if Lalamove ever does push
// something useful) but is no longer load-bearing — the fallback poller
// (internal.lalamove-poll.ts) is now the ONLY mechanism that actually
// fires in practice.
//
// Correlation is therefore explicit, not inferred: the merchant pastes the
// real Lalamove Order ID (visible in the Lalamove app's order detail
// "Additional info" section — NOT the tracking share-link, which carries an
// unrelated share token, not the order id) into the "Mark as fulfilled"
// modal alongside the tracking number/URL already collected there.

import prisma from "../db.server";
import { getOrderStatus, type LalamoveOrderStatus } from "../lib/lalamove-client.server";

// The Lalamove app displays the order id prefixed with "#" (e.g.
// "#3563144148557194173") — merchants naturally copy it that way. A leading
// "#" is the URL FRAGMENT delimiter: everything from it onward is stripped
// client-side before a request is ever sent, so the actual HTTP request line
// loses the id entirely while the HMAC signature (computed from the raw path
// string) still includes it — a real signature mismatch, not a credentials
// problem. Confirmed live 2026-08-16 (a merchant paste of "#3563144148557194173"
// produced "HMAC signature doesn't match the provided payload" from Lalamove).
export function sanitizeLalamoveOrderId(raw: string): string {
  return raw.trim().replace(/^#/, "").trim();
}

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const FULFILLMENT_EVENT_CREATE_MUTATION = `#graphql
  mutation LalamoveFulfillmentDelivered($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent { id status }
      userErrors { field message }
    }
  }
`;

export type MarkDeliveredResult =
  | { status: "delivered" }
  | { status: "not_tracked" }
  | { status: "already_delivered" }
  | { status: "shopify_write_failed"; error: string };

// Called when Lalamove reports COMPLETE for an order id — via the fallback
// poller (primary in practice) or the webhook route (best-effort, rarely
// fires — see the module doc above). `order`, when passed, is the already-
// fetched Lalamove order (poller/recordLalamoveOrderId both have one in
// hand) — its drop-off stop's own POD.deliveredAt becomes the Shopify
// DELIVERED event's `happenedAt` instead of "now", so the displayed
// delivery time reflects when the courier actually delivered rather than
// whenever this function happened to run (up to ~10 minutes later on the
// poller's cadence).
export async function markLalamoveOrderDelivered(
  admin: AdminGraphQLClient,
  lalamoveOrderId: string,
  order?: LalamoveOrderStatus,
): Promise<MarkDeliveredResult> {
  const row = await prisma.lalamoveTracking.findUnique({ where: { lalamoveOrderId } });
  if (!row) return { status: "not_tracked" };
  if (row.deliveredAt) return { status: "already_delivered" };

  const dropoff = order?.stops?.[order.stops.length - 1];
  const happenedAt = dropoff?.POD?.deliveredAt || new Date().toISOString();

  const res = await admin.graphql(FULFILLMENT_EVENT_CREATE_MUTATION, {
    variables: {
      fulfillmentEvent: {
        fulfillmentId: row.shopifyFulfillmentId,
        status: "DELIVERED",
        happenedAt,
      },
    },
  });
  const json = (await res.json()) as {
    data?: { fulfillmentEventCreate?: { userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  const errors = [
    ...(json.errors?.map((e) => e.message) ?? []),
    ...(json.data?.fulfillmentEventCreate?.userErrors?.map((e) => e.message) ?? []),
  ];
  if (errors.length > 0) {
    return { status: "shopify_write_failed", error: errors.join("; ") };
  }

  await prisma.lalamoveTracking.update({
    where: { lalamoveOrderId },
    data: { status: "COMPLETED", deliveredAt: new Date() },
  });
  return { status: "delivered" };
}

// Non-terminal status mirror (ON_GOING, PICKED_UP, etc.) — visibility only,
// no Shopify write.
export async function mirrorLalamoveOrderStatus(
  lalamoveOrderId: string,
  status: string,
): Promise<void> {
  try {
    await prisma.lalamoveTracking.update({ where: { lalamoveOrderId }, data: { status } });
  } catch (error) {
    // P2025 = record not found — genuinely not tracked, nothing to mirror.
    // Any OTHER error (e.g. a connection-pool timeout) must not vanish
    // silently, since this repo has already seen exactly that error class
    // in production for a sibling query.
    if ((error as { code?: string })?.code === "P2025") return;
    console.warn(
      `[lalamove-tracking] mirrorLalamoveOrderStatus failed for ${lalamoveOrderId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export type RecordLalamoveOrderIdResult =
  | { status: "recorded" }
  | { status: "already_delivered_now"; alreadyTracked: boolean }
  | { status: "already_tracked" }
  | { status: "not_found" }
  | { status: "lalamove_lookup_failed"; error: string }
  | { status: "shopify_write_failed"; error: string };

// The one write path for this feature: the merchant explicitly supplies the
// real Lalamove Order ID for a just-fulfilled order (via the "Mark as
// fulfilled" modal's optional field). Validates the id against Lalamove
// (fail fast on a mistyped id — e.g. the share-link token pasted by
// mistake), records the correlation, and — since the id might already be
// COMPLETE by the time it's pasted (the merchant may book/complete the
// courier before circling back to Shopify) — marks it delivered immediately
// if so, rather than waiting for the next poll cycle.
export async function recordLalamoveOrderId(
  admin: AdminGraphQLClient,
  shop: string,
  shopifyOrderId: string,
  shopifyFulfillmentId: string,
  lalamoveOrderId: string,
): Promise<RecordLalamoveOrderIdResult> {
  const trimmedId = sanitizeLalamoveOrderId(lalamoveOrderId);

  const statusResult = await getOrderStatus(trimmedId);
  if (!statusResult.ok) {
    if (statusResult.notFound) return { status: "not_found" };
    return { status: "lalamove_lookup_failed", error: statusResult.error };
  }

  // create() directly (no findUnique-then-create) so the database's own
  // unique constraint on lalamoveOrderId is what decides a race, not a
  // check-then-act gap: two near-simultaneous submissions of the same id
  // (double-click, or two orders both pasting it) can otherwise both pass a
  // separate findUnique before either create() commits.
  try {
    await prisma.lalamoveTracking.create({
      data: {
        shop,
        shopifyOrderId,
        shopifyFulfillmentId,
        lalamoveOrderId: trimmedId,
        status: statusResult.order.status,
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") return { status: "already_tracked" };
    throw error;
  }

  if (statusResult.order.status === "COMPLETED" || statusResult.order.status === "COMPLETE") {
    const result = await markLalamoveOrderDelivered(admin, trimmedId, statusResult.order);
    if (result.status === "shopify_write_failed") {
      return { status: "shopify_write_failed", error: result.error };
    }
    return { status: "already_delivered_now", alreadyTracked: true };
  }

  return { status: "recorded" };
}
