import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  getShopLocalDate,
} from "../../../../app/lib/delivery-availability";
import { toLocalISODate } from "../../../../app/lib/order-utils";
import {
  GET_ORDERS_QUERY,
  buildOrdersQueryPlan,
  fetchRecentRescheduleOrders,
  parseOrdersViewParams,
} from "../../../../app/lib/orders-view";
import {
  rescheduleBadgeLabel,
  selectRecentReschedules,
} from "../../../../app/lib/recent-reschedules";
import { executeBulkAction } from "../../../../app/services/bulk-actions";
import { runOrdersBulkOp } from "../../../../app/services/orders-bulk-op";
import { handleMarkRescheduleSeenOp } from "../../../../app/services/reschedule-seen.server";
import {
  getScheduleRules,
  getScheduleRulesWithBookedCounts,
} from "../../../../app/services/schedule-rules.server";
import { adminClient, getShopDomain } from "../admin-client";
import { sendRescheduleNotice } from "../email-client";
import { scheduleRulesStore } from "../scheduler-api";

async function readShopTimezone(shop) {
  return (await getScheduleRules(shop, scheduleRulesStore)).timezone;
}

/** Orders page data for the given URL query, in the shape the old loader returned. */
export async function loadOrders(searchParams) {
  const shop = await getShopDomain();
  const view = parseOrdersViewParams(searchParams);
  const { deliveryDateParam, searchParam, timeWindowParam, tabParam, sortParam } =
    view;

  let shopTimezone = DEFAULT_DELIVERY_SCHEDULE_RULES.timezone;
  try {
    shopTimezone = await readShopTimezone(shop);
  } catch (error) {
    console.warn(
      `[orders] timezone read failed, using ${shopTimezone}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const todayISO = getShopLocalDate(shopTimezone) || toLocalISODate(new Date());

  const { variables, pageSize, dateScoped } = buildOrdersQueryPlan(view, todayISO);

  const [response, recentRescheduleOrders] = await Promise.all([
    adminClient.graphql(GET_ORDERS_QUERY, { variables }),
    fetchRecentRescheduleOrders(adminClient, todayISO),
  ]);
  const body = await response.json();
  const orders = body.data?.orders?.edges?.map((edge) => edge.node) ?? [];

  const shopLocal = { todayISO, timezone: shopTimezone };
  for (const order of orders) {
    order.rescheduleBadgeLabel = rescheduleBadgeLabel(order, shopLocal);
  }

  return {
    orders,
    pageInfo: body.data?.orders?.pageInfo ?? null,
    errors: body.errors ?? null,
    deliveryDateParam,
    searchParam,
    timeWindowParam,
    tabParam,
    sortParam,
    todayISO,
    shopTimezone,
    pageSize,
    dateScoped,
    recentReschedules: selectRecentReschedules(recentRescheduleOrders, shopLocal),
  };
}

const bulkActionDeps = {
  getShopTimezone: readShopTimezone,
  sendRescheduleNotice,
};

/** Runs one bulk op from form fields; resolves to the BulkActionResponse body. */
export async function submitOrdersOp(fields) {
  const shop = await getShopDomain();
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) fd.append(key, item);
    } else {
      fd.append(key, value);
    }
  }
  try {
    const { body } = await runOrdersBulkOp(adminClient, shop, fd, {
      getScheduleRulesWithBookedCounts: (forShop, admin) =>
        getScheduleRulesWithBookedCounts(forShop, admin, {
          store: scheduleRulesStore,
        }),
      executeBulkAction: (admin, forShop, params, orderIds) =>
        executeBulkAction(admin, forShop, params, orderIds, bulkActionDeps),
    });
    return body;
  } catch (error) {
    console.error(`Orders op "${fields._action}" failed:`, error);
    return {
      ok: false,
      action: null,
      message: error instanceof Error ? error.message : "Action failed.",
      results: [],
      summary: { ok: 0, failed: 0 },
    };
  }
}

/** Marks recent-reschedule rows seen; resolves to {ok, message}. */
export async function markReschedulesSeen(items) {
  const fd = new FormData();
  fd.append("_action", "markRescheduleSeen");
  for (const item of items) {
    fd.append("orderId", item.orderId);
    fd.append("requestedAt", item.requestedAt);
  }
  const response = await handleMarkRescheduleSeenOp(adminClient, fd);
  return response.json();
}

/** Rules subset the reschedule modal reads, with live booked counts. */
export async function loadRescheduleRules() {
  const shop = await getShopDomain();
  const rules = await getScheduleRulesWithBookedCounts(shop, adminClient, {
    store: scheduleRulesStore,
  });
  return {
    timezone: rules.timezone,
    slots: rules.slots,
    disabledDates: rules.disabledDates,
    disabledSlots: rules.disabledSlots,
    slotCapacity: rules.slotCapacity,
  };
}
