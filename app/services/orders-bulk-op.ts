// Orders page bulk-op request handling: op and selection checks, per-op param
// validation, the reschedule capacity projection, then the executor.

import {
  validateMerchantRescheduleSelection,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import { MAX_ORDER_TAG_LENGTH } from "../lib/order-tags";
import { slotValuesMatch } from "../lib/slot-value";
import {
  MAX_SELECTED_ORDER_IDS,
  fetchRescheduleOrderStates,
  isBulkActionName,
  rescheduleCurrentDateOf,
  rescheduleCurrentSlotOf,
  type AdminGraphQLClient,
  type BulkActionItemResult,
  type BulkActionName,
  type BulkActionResponse,
  type BulkOpParams,
} from "./bulk-actions";

const MAX_TAG_LENGTH = MAX_ORDER_TAG_LENGTH;

export interface OrdersBulkOpDeps {
  getScheduleRulesWithBookedCounts: (
    shop: string,
    admin: AdminGraphQLClient,
  ) => Promise<DeliveryScheduleRules>;
  executeBulkAction: (
    admin: AdminGraphQLClient,
    shop: string,
    params: BulkOpParams,
    orderIds: string[],
  ) => Promise<BulkActionItemResult[]>;
}

export interface OrdersBulkOpResult {
  status: number;
  body: BulkActionResponse;
}

function isHttpTrackingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function runOrdersBulkOp(
  admin: AdminGraphQLClient,
  shop: string,
  fd: FormData,
  deps: OrdersBulkOpDeps,
): Promise<OrdersBulkOpResult> {
  const opRaw = String(fd.get("_action") || "");
  const op = isBulkActionName(opRaw) ? opRaw : "";
  const orderIds = Array.from(
    new Set(
      fd
        .getAll("orderId")
        .map((v) => String(v))
        .filter(Boolean),
    ),
  );

  const empty: BulkActionResponse = {
    ok: false,
    action: (op || null) as BulkActionName | null,
    message: "No orders selected.",
    results: [],
    summary: { ok: 0, failed: 0 },
  };

  if (!op) {
    return {
      status: 400,
      body: { ...empty, message: opRaw ? "Unknown action." : "Missing action." },
    };
  }
  if (orderIds.length === 0) {
    return { status: 400, body: empty };
  }
  if (orderIds.length > MAX_SELECTED_ORDER_IDS) {
    return {
      status: 400,
      body: {
        ...empty,
        message: `Select ${MAX_SELECTED_ORDER_IDS} or fewer orders at a time.`,
      },
    };
  }

  let opParams: BulkOpParams;
  if (op === "archive" || op === "unarchive") {
    opParams = { op };
  } else if (op === "markAsPaid") {
    opParams = { op: "markAsPaid" };
  } else if (op === "cancel") {
    const validReasons = new Set([
      "CUSTOMER",
      "INVENTORY",
      "DECLINED",
      "FRAUD",
      "STAFF",
      "OTHER",
    ]);
    const reasonRaw = String(fd.get("reason") || "CUSTOMER").toUpperCase();
    const reason = validReasons.has(reasonRaw) ? reasonRaw : "CUSTOMER";
    const restock = fd.get("restock") === "1";
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    const staffNoteRaw = String(fd.get("staffNote") || "").slice(0, 255);
    opParams = {
      op: "cancel",
      reason,
      restock,
      notifyCustomer,
      staffNote: staffNoteRaw.trim() || null,
    };
  } else if (op === "tagsAdd" || op === "tagsRemove") {
    const tags = String(fd.get("tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) {
      return { status: 400, body: { ...empty, message: "Enter at least one tag." } };
    }
    if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      return {
        status: 400,
        body: {
          ...empty,
          message: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
        },
      };
    }
    opParams = { op, tags };
  } else if (op === "markFulfilled") {
    const trackingUrl = String(fd.get("trackingUrl") || "").trim();
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    if (trackingUrl && !isHttpTrackingUrl(trackingUrl)) {
      return {
        status: 400,
        body: {
          ...empty,
          message: "Tracking URL must start with http:// or https://.",
        },
      };
    }
    opParams = { op: "markFulfilled", trackingUrl, notifyCustomer };
  } else {
    // Merchant reschedule checks data integrity only; capacity is warn plus
    // an explicit override.
    const date = String(fd.get("date") || "").trim();
    const timeSlot = String(fd.get("timeSlot") || "").trim();
    const override = fd.get("capacityOverride") === "1";

    const rules = await deps.getScheduleRulesWithBookedCounts(shop, admin);
    const check = validateMerchantRescheduleSelection(rules, date, timeSlot);
    if (!check.ok) {
      return { status: 400, body: { ...empty, message: check.message } };
    }

    if (check.capacity) {
      // Orders already in the target date and slot (canonical slot compare)
      // do not count as moving.
      const stateFetch = await fetchRescheduleOrderStates(admin, orderIds);
      if (!stateFetch.ok) {
        return {
          status: 200,
          body: {
            ...empty,
            message: stateFetch.message,
            results: orderIds.map((id) => ({
              orderId: id,
              success: false,
              message: stateFetch.message,
            })),
            summary: { ok: 0, failed: orderIds.length },
          },
        };
      }
      const moving = orderIds.filter((id) => {
        const state = stateFetch.stateByOrderId.get(id);
        if (!state) return false;
        return (
          rescheduleCurrentDateOf(state) !== date ||
          !slotValuesMatch(rescheduleCurrentSlotOf(state), timeSlot)
        );
      }).length;
      const projected = check.capacity.booked + moving;
      if (moving > 0 && projected > check.capacity.capacity && !override) {
        return {
          status: 409,
          body: {
            ...empty,
            message: `Moving ${moving} ${moving === 1 ? "order" : "orders"} would put ${date} ${timeSlot} at ${projected}/${check.capacity.capacity}.`,
            code: "capacity_override_required",
            capacity: {
              capacity: check.capacity.capacity,
              booked: check.capacity.booked,
              moving,
              projected,
            },
          },
        };
      }
    }

    opParams = {
      op: "reschedule",
      date,
      timeSlot,
      notifyCustomer: fd.get("notifyCustomer") === "1",
      // One timestamp for every order in this submit.
      requestedAt: new Date().toISOString(),
      shopTimezone: rules.timezone,
    };
  }

  const results: BulkActionItemResult[] = await deps.executeBulkAction(
    admin,
    shop,
    opParams,
    orderIds,
  );

  const okCount = results.filter((r) => r.success).length;
  const failedCount = results.length - okCount;
  return {
    status: 200,
    body: {
      ok: failedCount === 0,
      action: op,
      results,
      summary: { ok: okCount, failed: failedCount },
    },
  };
}
