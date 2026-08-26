// Delivery-sync work queue (ADR-22, Phase A of docs/proposals/orders-async-jobs.md).
//
// THE ROW IS THE RESUME POINT. The orders/create webhook no longer performs
// the sync inline — it upserts a DeliverySyncTask row (the durable record of
// work owed) and enqueues a Cloud Tasks job; this module is what the worker
// route, the hourly sweep, and the ops-page retry button all call to actually
// run the sync. Fixes review findings M1 (a transient failure used to be a
// permanent silent skip — the booked-count engine then undercounted that
// order forever) and S5 (a partial sync left no marker of which half
// happened).
//
// Two merchant constraints (2026-08-26) are load-bearing here:
//
// 1. NO DOUBLE-PROCESSING — claimDeliverySyncTask is one conditional
//    updateMany: the check ("unclaimed or stale") and the take (lockedAt=now)
//    are a single SQL UPDATE, so Postgres row-locking makes the loser see
//    count 0 and walk away. Behind the lease, every step is idempotent on the
//    Shopify side (metafieldsSet = set semantics, tagsAdd = add-if-absent,
//    applyCodFeeToOrder scans for the fee SKU before adding), so even a
//    pathological lease overlap can only re-write the same values.
//
// 2. A PAID ORDER IS NEVER REJECTED FOR CUTOFF AT RETRY TIME — D4/DEF-7
//    semantics carried whole: validation is a flag (`delivery.sync_status`),
//    never a gate, and its clock is the checkoutTime FROZEN on the row, never
//    the retry time. A sync delayed by hours gives the identical verdict the
//    checkout moment deserved.
//
// Pacing split: Cloud Tasks retries pace themselves via the queue's own
// backoff policy (worker returns 503 on transient failure); `nextAttemptAt`
// is the SWEEP's "not before" marker for rescuing stranded rows — the worker
// deliberately does not gate on it.
//
// Posture: work BOOKKEEPING only. The Shopify order stays the delivery-state
// ledger; nothing in this table is ever read as delivery state.

import prisma from "../db.server";
import { applyCodFeeToOrder } from "./cod-fee.server";
import { enqueueDeliverySyncTask } from "./messenger-queue.server";
import {
  evaluateDeliverySyncStatus,
  syncOrderDeliveryMetafields,
  syncOrderDeliveryScheduleTag,
} from "./order-delivery-metafields.server";
import { getScheduleRulesDetailed } from "./schedule-rules.server";
import { unauthenticated } from "../shopify.server";

export const DELIVERY_SYNC_MAX_ATTEMPTS = 8;
export const DELIVERY_SYNC_LEASE_MS = 5 * 60 * 1000;

// Sweep pacing only (see the module doc): 1m, 5m, 15m, 1h, 3h, 6h, 12h —
// then the attempts cap fails the task (~22h of trying in total).
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720];

export function deliverySyncBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx] * 60 * 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface UpsertDeliverySyncTaskInput {
  shop: string;
  shopifyOrderId: string;
  orderName: string | null;
  deliveryDate: string | null;
  timeSlot: string | null;
  checkoutTime: Date;
  needsCodFee: boolean;
}

// Called by the webhook BEFORE it acks 200 — deliberately NOT guarded: if
// this write fails, the webhook 500s and Shopify's own redelivery becomes the
// durable fallback. A redelivery upserts into the same row (unique
// shop+orderId) and must never clobber progress already made — step flags,
// attempts, and status are left untouched on update. Steps with nothing to do
// are created already-done, so "done" is always simply "all three flags true".
export async function upsertDeliverySyncTask(
  input: UpsertDeliverySyncTaskInput,
): Promise<{ id: string }> {
  const hasDelivery = Boolean(input.deliveryDate && input.timeSlot);
  const row = await prisma.deliverySyncTask.upsert({
    where: {
      shop_shopifyOrderId: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
      },
    },
    create: {
      shop: input.shop,
      shopifyOrderId: input.shopifyOrderId,
      orderName: input.orderName,
      deliveryDate: input.deliveryDate,
      timeSlot: input.timeSlot,
      checkoutTime: input.checkoutTime,
      needsCodFee: input.needsCodFee,
      metafieldsDone: !hasDelivery,
      tagsDone: !hasDelivery,
      codFeeDone: !input.needsCodFee,
    },
    update: {
      orderName: input.orderName,
    },
  });
  return { id: row.id };
}

// §2a atomic claim (see the module doc). Exported for tests; callers go
// through processDeliverySyncTask.
export async function claimDeliverySyncTask(
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - DELIVERY_SYNC_LEASE_MS);
  const claimed = await prisma.deliverySyncTask.updateMany({
    where: {
      id,
      status: "pending",
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    data: { lockedAt: now },
  });
  return claimed.count === 1;
}

export type ProcessDeliverySyncResult =
  | { status: "done" }
  | { status: "terminal" } // already done or failed — a retry can't help
  | { status: "not_found" }
  | { status: "locked" } // another worker holds the lease — walk away
  | { status: "failed"; error: string } // permanent — do not retry
  | { status: "retry"; error: string }; // transient — Cloud Tasks should retry

export async function processDeliverySyncTask(
  taskId: string,
): Promise<ProcessDeliverySyncResult> {
  const row = await prisma.deliverySyncTask.findUnique({ where: { id: taskId } });
  if (!row) return { status: "not_found" };
  if (row.status !== "pending") return { status: "terminal" };
  if (!(await claimDeliverySyncTask(taskId))) return { status: "locked" };

  try {
    let admin;
    try {
      ({ admin } = await unauthenticated.admin(row.shop));
    } catch (error) {
      // No offline session is not transient (uninstalled store / cleaned-up
      // token) — fail terminally instead of burning 8 retries.
      const message = `no offline session for ${row.shop}: ${errorMessage(error)}`;
      console.warn(`[delivery-sync] ${row.shopifyOrderId}: ${message}`);
      await prisma.deliverySyncTask.update({
        where: { id: taskId },
        data: { status: "failed", lastError: message, lockedAt: null },
      });
      return { status: "failed", error: message };
    }

    const errors: string[] = [];
    let { metafieldsDone, tagsDone, codFeeDone } = row;
    const deliveryDate = row.deliveryDate;
    const timeSlot = row.timeSlot;

    if (deliveryDate && timeSlot && !metafieldsDone) {
      try {
        // The row's own booking is excluded from the counts, same as every
        // other caller — a retry (its `custom.date` possibly already written
        // by a prior partial attempt) must not count the order against its
        // own slot.
        const { rules, countsMeta } = await getScheduleRulesDetailed(row.shop, admin, {
          excludeOrderId: row.shopifyOrderId,
        });
        if (countsMeta.status === "error" || countsMeta.status === "partial") {
          console.warn(
            `[delivery-sync] booked counts ${countsMeta.status}; capacity check ran fail-open for ${row.shopifyOrderId}.`,
          );
        }
        // Merchant constraint (2): the FROZEN clock — the order's checkout
        // time as stored on the row, never "now".
        const syncStatus = evaluateDeliverySyncStatus(
          rules,
          deliveryDate,
          timeSlot,
          row.checkoutTime,
        );
        if (syncStatus !== "ok") {
          console.warn(
            `[delivery-sync] ${row.shopifyOrderId} needs attention (${syncStatus}); syncing anyway (D4).`,
          );
        }
        const result = await syncOrderDeliveryMetafields(admin, {
          orderId: row.shopifyOrderId,
          deliveryDate,
          timeSlot,
          syncStatus,
        });
        if (result.ok) {
          metafieldsDone = true;
          await prisma.deliverySyncTask.update({
            where: { id: taskId },
            data: { metafieldsDone: true },
          });
        } else {
          errors.push(`metafields: ${result.errors.join("; ") || "sync failed"}`);
        }
      } catch (error) {
        errors.push(`metafields: ${errorMessage(error)}`);
      }
    }

    if (deliveryDate && timeSlot && !tagsDone) {
      try {
        const tagResult = await syncOrderDeliveryScheduleTag(admin, {
          orderId: row.shopifyOrderId,
          deliveryDate,
          timeSlot,
        });
        if (tagResult.ok) {
          tagsDone = true;
          await prisma.deliverySyncTask.update({
            where: { id: taskId },
            data: { tagsDone: true },
          });
        } else {
          errors.push(`tags: ${tagResult.errors.join("; ") || "sync failed"}`);
        }
      } catch (error) {
        errors.push(`tags: ${errorMessage(error)}`);
      }
    }

    if (row.needsCodFee && !codFeeDone) {
      try {
        // `skipped` (fee already present / order not eligible) is success —
        // the scan-before-add inside applyCodFeeToOrder is what makes retries
        // safe here; the lease protects its check-then-act window.
        const feeResult = await applyCodFeeToOrder(admin, {
          orderId: row.shopifyOrderId,
        });
        if (feeResult.ok) {
          codFeeDone = true;
          await prisma.deliverySyncTask.update({
            where: { id: taskId },
            data: { codFeeDone: true },
          });
        } else {
          errors.push(`codFee: ${feeResult.errors.join("; ") || "fee failed"}`);
        }
      } catch (error) {
        errors.push(`codFee: ${errorMessage(error)}`);
      }
    }

    if (metafieldsDone && tagsDone && codFeeDone) {
      await prisma.deliverySyncTask.update({
        where: { id: taskId },
        data: { status: "done", doneAt: new Date(), lockedAt: null, lastError: null },
      });
      console.log(`[delivery-sync] ${row.shopifyOrderId}: done.`);
      return { status: "done" };
    }

    const attempts = row.attempts + 1;
    const lastError = errors.join(" | ") || "unknown";
    if (attempts >= DELIVERY_SYNC_MAX_ATTEMPTS) {
      await prisma.deliverySyncTask.update({
        where: { id: taskId },
        data: { status: "failed", attempts, lastError, lockedAt: null },
      });
      console.warn(
        `[delivery-sync] ${row.shopifyOrderId}: FAILED after ${attempts} attempts (${lastError}).`,
      );
      return { status: "failed", error: lastError };
    }
    await prisma.deliverySyncTask.update({
      where: { id: taskId },
      data: {
        attempts,
        lastError,
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + deliverySyncBackoffMs(attempts)),
      },
    });
    console.warn(
      `[delivery-sync] ${row.shopifyOrderId}: attempt ${attempts} incomplete (${lastError}); will retry.`,
    );
    return { status: "retry", error: lastError };
  } catch (error) {
    // Unexpected throw (e.g. Neon dropping mid-update): release the lease so
    // the next attempt isn't stuck behind a 5-minute stale window.
    try {
      await prisma.deliverySyncTask.updateMany({
        where: { id: taskId },
        data: { lockedAt: null },
      });
    } catch {
      // The lease goes stale on its own — nothing more to do here.
    }
    throw error;
  }
}

// ─── Merchant visibility (the ops-page banner) ───────────────────────────────

export interface DeliverySyncIssueSummary {
  count: number;
  orderNames: string[];
}

// Hard-failed tasks plus pending ones that have already burned 3+ attempts —
// still retrying, but old enough that the merchant should see them.
const ISSUE_WHERE = (shop: string) => ({
  shop,
  OR: [
    { status: "failed" },
    { status: "pending", attempts: { gte: 3 } },
  ],
});

export async function getDeliverySyncIssues(
  shop: string,
  sampleSize = 3,
): Promise<DeliverySyncIssueSummary> {
  const where = ISSUE_WHERE(shop);
  const [count, sample] = await Promise.all([
    prisma.deliverySyncTask.count({ where }),
    prisma.deliverySyncTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: sampleSize,
      select: { orderName: true, shopifyOrderId: true },
    }),
  ]);
  return {
    count,
    orderNames: sample.map(
      (r: { orderName: string | null; shopifyOrderId: string }) =>
        r.orderName || `#${r.shopifyOrderId.split("/").pop() ?? r.shopifyOrderId}`,
    ),
  };
}

export interface RetryDeliverySyncResult {
  retried: number;
}

// The banner's "Retry sync" action: give every surfaced row a fresh allowance
// and (best-effort) a task each. A row whose enqueue fails stays due for the
// sweep because nextAttemptAt was reset to now; when no queue is configured
// (local dev) the rows are processed inline instead.
export async function retryDeliverySyncIssues(
  shop: string,
): Promise<RetryDeliverySyncResult> {
  const rows = await prisma.deliverySyncTask.findMany({
    where: ISSUE_WHERE(shop),
    select: { id: true },
    take: 50,
  });
  if (rows.length === 0) return { retried: 0 };
  await prisma.deliverySyncTask.updateMany({
    where: { id: { in: rows.map((r: { id: string }) => r.id) } },
    data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedAt: null },
  });
  for (const r of rows) {
    const enq = await enqueueDeliverySyncTask({ taskId: r.id });
    if (!enq.ok && enq.notConfigured) {
      try {
        await processDeliverySyncTask(r.id);
      } catch (error) {
        console.warn(
          `[delivery-sync] inline retry for task ${r.id} threw: ${errorMessage(error)}`,
        );
      }
    } else if (!enq.ok) {
      console.warn(`[delivery-sync] retry enqueue failed for task ${r.id}: ${enq.error}`);
    }
  }
  return { retried: rows.length };
}
