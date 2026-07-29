// orders/create delivery sync (Scheduler V2 D4 — docs/scheduler-v2-ux.md §6).
//
// A paid order's delivery data is ALWAYS synced when date+slot are parseable —
// validation no longer gates the write (audit DEF-7). Validation runs with
// checkout-time semantics ("now" = the order's created_at, so a late-retried
// webhook can't invalidate a legal checkout) and its outcome is recorded on
// the additive `delivery.sync_status` metafield ("ok" | "attention:<code>").
// Capacity is advisory only: over-capacity yields "attention:capacity" (§6.4).
//
// Also hosts the COD fee auto-add (services/cod-fee.server.ts): orders paid
// via the manual "Cash on Delivery" method get the COD-fee variant added via
// order edit — independent of the delivery sync, never blocks the 200.

import { authenticate, unauthenticated } from "../shopify.server";
import {
  applyCodFeeToOrder,
  isCashOnDeliveryOrder,
} from "../services/cod-fee.server";
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

  const isCodOrder = orderId ? isCashOnDeliveryOrder(orderPayload) : false;
  const hasDeliveryAttributes = Boolean(orderId && deliveryDate && timeSlot);

  if (!hasDeliveryAttributes && !isCodOrder) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  // A shop without a stored offline session (e.g. the PROD app receiving a
  // webhook for a store it only nominally remains installed on, or a token
  // cleaned up by app/uninstalled) must NOT 5xx — Shopify retries on non-200
  // and eventually flags the subscription. Log + ack instead.
  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.warn(
      `[orders/create] skipped: no offline session for ${shop} (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
    return new Response();
  }

  // COD fee runs independently of the delivery sync: a COD order without
  // parseable delivery attributes still gets its fee.
  if (isCodOrder && orderId) {
    const feeResult = await applyCodFeeToOrder(admin, { orderId });
    if (feeResult.skipped) {
      console.log(`[orders/create] COD fee skipped: ${feeResult.reason}.`);
    } else if (!feeResult.ok) {
      console.warn(
        `[orders/create] COD fee failed: ${feeResult.errors.join("; ")}`,
      );
    } else {
      console.log("[orders/create] COD fee added via order edit.");
    }
  }

  if (!hasDeliveryAttributes || !orderId || !deliveryDate || !timeSlot) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  // Counts-loaded rules so an over-capacity checkout can be flagged; the
  // detailed read fails open (countsMeta "error" → booked stays 0) so a
  // broken Admin scan can never block the sync itself. Its Postgres read is
  // NOT inside that fail-open catch, though, so a Neon cold-start rejection
  // would escape the handler as a 500 — which Shopify retries and eventually
  // flags the subscription for (same reason as the offline-session guard).
  let rules;
  let countsMeta;
  try {
    // This order's own booking is excluded from the counts so a webhook
    // redelivery (its `custom.date` already written) cannot count the order
    // against its own slot and flag a legal in-capacity order as
    // "attention:capacity" — same exclusion both reschedule routes pass.
    ({ rules, countsMeta } = await getScheduleRulesDetailed(shop, admin, {
      excludeOrderId: orderId,
    }));
  } catch (error) {
    console.warn(
      `[orders/create] delivery sync skipped: schedule rules unavailable for ${shop} (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
    return new Response();
  }

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
  // "partial" is a truncated scan, not a failed one: the counts are a lower
  // bound, so the capacity check still runs (fail-open) but must not pass
  // silently — an under-counted slot is exactly how an over-capacity order
  // gets stamped "ok".
  if (countsMeta.status === "error" || countsMeta.status === "partial") {
    console.warn(
      `[orders/create] booked counts ${
        countsMeta.status === "partial" ? "incomplete" : "unavailable"
      }; capacity check ran fail-open.`,
    );
  }

  // Both sync calls report their own failures via `ok: false`, but a transient
  // Admin fetch rejection throws instead — log + ack rather than let it 5xx.
  try {
    const result = await syncOrderDeliveryMetafields(admin, {
      orderId,
      deliveryDate,
      timeSlot,
      syncStatus,
    });

    if (!result.ok) {
      console.warn("[orders/create] delivery metafield sync failed.");
    }
  } catch (error) {
    console.warn(
      `[orders/create] delivery metafield sync failed for ${orderId} on ${shop} (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }

  try {
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
  } catch (error) {
    console.warn(
      `[orders/create] delivery schedule tag sync failed for ${orderId} on ${shop} (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }

  return new Response();
};
