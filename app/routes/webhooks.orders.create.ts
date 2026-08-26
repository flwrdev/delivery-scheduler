// orders/create delivery sync — THIN receiver (ADR-22, Phase A of
// docs/proposals/orders-async-jobs.md; was the inline-sync handler until
// 2026-08-26).
//
// This route no longer performs the sync itself. It extracts the work input
// from the payload (purely local), upserts the durable DeliverySyncTask row —
// the record of work owed — enqueues a Cloud Tasks job, and acks 200. Every
// upstream call (offline session, schedule rules, metafieldsSet, tagsAdd, COD
// fee) lives in the worker (webhooks.delivery-sync_.worker.ts), where a
// transient failure is a retry instead of a permanent silent skip (review
// finding M1) and progress is checkpointed per step (S5). The hourly sweep
// (internal.delivery-sync-sweep.ts) rescues stranded rows.
//
// D4 preserved (audit DEF-7 + merchant constraint 2026-08-26): a paid order's
// delivery data is ALWAYS synced when date+slot are parseable — validation
// never gates the write, only stamps `delivery.sync_status`, and the
// validation clock is the checkoutTime frozen on the row here, never the
// retry time.
//
// FAILURE CONTRACT: the ONLY intentional non-200 is the task-row upsert
// failing (Neon truly down) — the handler then throws, and Shopify's own
// webhook redelivery becomes the durable fallback. Once the row exists,
// everything else is best-effort here: enqueue failure → one inline attempt →
// the sweep as backstop.

import { authenticate } from "../shopify.server";
import { isCashOnDeliveryOrder } from "../services/cod-fee.server";
import {
  processDeliverySyncTask,
  upsertDeliverySyncTask,
} from "../services/delivery-sync-task.server";
import { enqueueDeliverySyncTask } from "../services/messenger-queue.server";
import {
  extractDeliveryAttributesFromPayload,
  getOrderGidFromPayload,
  resolveOrderCheckoutTime,
} from "../services/order-delivery-metafields.server";

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;
  const orderId = getOrderGidFromPayload(orderPayload);
  const { deliveryDate, timeSlot } =
    extractDeliveryAttributesFromPayload(orderPayload);

  console.log("[orders/create] webhook received.");

  const isCodOrder = orderId ? isCashOnDeliveryOrder(orderPayload) : false;
  const hasDeliveryAttributes = Boolean(orderId && deliveryDate && timeSlot);

  if (!orderId || (!hasDeliveryAttributes && !isCodOrder)) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  const rawName = orderPayload.name;
  const orderName =
    typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;

  // Durable first — NOT guarded on purpose (see the failure contract above).
  const task = await upsertDeliverySyncTask({
    shop,
    shopifyOrderId: orderId,
    orderName,
    deliveryDate: hasDeliveryAttributes ? deliveryDate : null,
    timeSlot: hasDeliveryAttributes ? timeSlot : null,
    checkoutTime: resolveOrderCheckoutTime(orderPayload),
    needsCodFee: isCodOrder,
  });

  const enqueued = await enqueueDeliverySyncTask({ taskId: task.id });
  if (!enqueued.ok) {
    if (!enqueued.notConfigured) {
      console.warn(`[orders/create] enqueue failed (${enqueued.error}); trying inline.`);
    }
    // Local dev (no queue) or an enqueue hiccup: one inline attempt while the
    // webhook still has CPU. The row's claim guards double-processing, and a
    // failure here just leaves the row pending for the sweep.
    try {
      await processDeliverySyncTask(task.id);
    } catch (error) {
      console.warn(
        `[orders/create] inline sync attempt threw for ${orderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return new Response();
};
