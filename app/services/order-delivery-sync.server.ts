import { applyCodFeeToOrder } from "./cod-fee.server";
import {
  type AdminGraphQLClient,
  evaluateDeliverySyncStatus,
  syncOrderDeliveryMetafields,
  syncOrderDeliveryScheduleTag,
} from "./order-delivery-metafields.server";
import { getScheduleRulesDetailed } from "./schedule-rules.server";

export interface OrderDeliverySyncInput {
  shop: string;
  orderId: string;
  deliveryDate: string | null;
  timeSlot: string | null;
  checkoutTime: Date;
  needsCodFee: boolean;
}

export interface OrderDeliverySyncResult {
  ok: boolean;
  errors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Every step is idempotent on the Shopify side (metafieldsSet overwrites,
// tagsAdd skips existing tags, applyCodFeeToOrder scans for the fee SKU
// before adding), so a Shopify webhook redelivery can safely re-run it.
async function runOrderDeliverySync(
  admin: AdminGraphQLClient,
  input: OrderDeliverySyncInput,
): Promise<OrderDeliverySyncResult> {
  const errors: string[] = [];
  const { deliveryDate, timeSlot } = input;

  if (deliveryDate && timeSlot) {
    try {
      // The order is excluded from the counts so a redelivery, whose
      // `custom.date` may already be written, never counts against its own slot.
      const { rules, countsMeta } = await getScheduleRulesDetailed(input.shop, admin, {
        excludeOrderId: input.orderId,
      });
      if (countsMeta.status === "error" || countsMeta.status === "partial") {
        console.warn(
          `[delivery-sync] booked counts ${countsMeta.status}; capacity check ran fail-open for ${input.orderId}.`,
        );
      }
      const syncStatus = evaluateDeliverySyncStatus(
        rules,
        deliveryDate,
        timeSlot,
        input.checkoutTime,
      );
      if (syncStatus !== "ok") {
        console.warn(
          `[delivery-sync] ${input.orderId} needs attention (${syncStatus}); syncing anyway.`,
        );
      }
      const result = await syncOrderDeliveryMetafields(admin, {
        orderId: input.orderId,
        deliveryDate,
        timeSlot,
        syncStatus,
      });
      if (!result.ok) {
        errors.push(`metafields: ${result.errors.join("; ") || "sync failed"}`);
      }
    } catch (error) {
      errors.push(`metafields: ${errorMessage(error)}`);
    }

    try {
      const tagResult = await syncOrderDeliveryScheduleTag(admin, {
        orderId: input.orderId,
        deliveryDate,
        timeSlot,
      });
      if (!tagResult.ok) {
        errors.push(`tags: ${tagResult.errors.join("; ") || "sync failed"}`);
      }
    } catch (error) {
      errors.push(`tags: ${errorMessage(error)}`);
    }
  }

  if (input.needsCodFee) {
    try {
      const feeResult = await applyCodFeeToOrder(admin, { orderId: input.orderId });
      if (!feeResult.ok) {
        errors.push(`codFee: ${feeResult.errors.join("; ") || "fee failed"}`);
      }
    } catch (error) {
      errors.push(`codFee: ${errorMessage(error)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// applyCodFeeToOrder is check-then-add, so two overlapping runs for the same
// order could both add the fee. Overlapping deliveries that reach the same
// instance share one run; this does not span Cloud Run instances.
const inFlight = new Map<string, Promise<OrderDeliverySyncResult>>();

export function syncOrderDelivery(
  admin: AdminGraphQLClient,
  input: OrderDeliverySyncInput,
): Promise<OrderDeliverySyncResult> {
  const key = `${input.shop}|${input.orderId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = runOrderDeliverySync(admin, input).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}
