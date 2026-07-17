// orders/create delivery sync (Scheduler V2 D4 — docs/scheduler-v2-ux.md §6).
//
// A paid order's delivery data is ALWAYS synced when date+slot are parseable —
// validation no longer gates the write (audit DEF-7). Validation runs with
// checkout-time semantics ("now" = the order's created_at, so a late-retried
// webhook can't invalidate a legal checkout) and its outcome is recorded on
// the additive `delivery.sync_status` metafield ("ok" | "attention:<code>").
// Capacity is advisory only: over-capacity yields "attention:capacity" (§6.4).

import { authenticate, unauthenticated } from "../shopify.server";
import {
  evaluateDeliverySyncStatus,
  extractDeliveryAttributesFromPayload,
  getOrderGidFromPayload,
  resolveOrderCheckoutTime,
  syncOrderDeliveryScheduleTag,
  syncOrderDeliveryMetafields,
} from "../services/order-delivery-metafields.server";
import { getScheduleRulesDetailed } from "../services/schedule-rules.server";

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;
  const orderId = getOrderGidFromPayload(orderPayload);
  const { deliveryDate, timeSlot } =
    extractDeliveryAttributesFromPayload(orderPayload);

  console.log("[orders/create] webhook received.");

  if (!orderId || !deliveryDate || !timeSlot) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  const { admin } = await unauthenticated.admin(shop);

  // Counts-loaded rules so an over-capacity checkout can be flagged; the
  // detailed read fails open (countsMeta "error" → booked stays 0) so a
  // broken Admin scan can never block the sync itself.
  const { rules, countsMeta } = await getScheduleRulesDetailed(shop, admin);
  const checkoutTime = resolveOrderCheckoutTime(orderPayload);
  const syncStatus = evaluateDeliverySyncStatus(
    rules,
    deliveryDate,
    timeSlot,
    checkoutTime,
  );

  if (syncStatus !== "ok") {
    console.warn(
      `[orders/create] delivery selection needs attention (${syncStatus}); syncing anyway (D4).`,
    );
  }
  if (countsMeta.status === "error") {
    console.warn(
      "[orders/create] booked counts unavailable; capacity check ran fail-open.",
    );
  }

  const result = await syncOrderDeliveryMetafields(admin, {
    orderId,
    deliveryDate,
    timeSlot,
    syncStatus,
  });

  if (!result.ok) {
    console.warn("[orders/create] delivery metafield sync failed.");
  }

  const tagResult = await syncOrderDeliveryScheduleTag(admin, {
    orderId,
    deliveryDate,
    timeSlot,
  });

  if (!tagResult.ok) {
    console.warn("[orders/create] delivery schedule tag sync failed.");
  } else if (tagResult.skipped) {
    console.log(
      "[orders/create] delivery schedule tags skipped: missing delivery date or time slot attribute.",
    );
  } else {
    console.log(
      `[orders/create] delivery sync completed (sync_status: ${syncStatus}).`,
    );
  }

  return new Response();
};
