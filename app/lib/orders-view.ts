// Orders page view logic shared by every Orders page host: URL params, the
// orders search query, client-side view shaping, tab counts and KPIs.

import { buildDeliveryDateTagQuery } from "./order-tags";
import { computeDateRefs, enumerateISODates, type DateRefs } from "./date-refs";
import {
  type Order,
  formatDeliveryDate,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getMeaningfulTags,
  isUnpaidStatus,
} from "./order-utils";
import { buildRecentRescheduleSearchQuery } from "./recent-reschedules";
import type { AdminGraphQLClient } from "../services/order-delivery-metafields.server";

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

// ─── GraphQL Query ────────────────────────────────────────────────────────────

export const GET_ORDERS_QUERY = `
  query GetOrdersTable(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $query: String
    $reverse: Boolean!
  ) {
    orders(
      first: $first
      after: $after
      last: $last
      before: $before
      query: $query
      sortKey: CREATED_AT
      reverse: $reverse
    ) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          statusPageUrl
          tags
          note
          customer {
            id
            firstName
            lastName
            numberOfOrders
            defaultEmailAddress {
              emailAddress
            }
            defaultPhoneNumber {
              phoneNumber
            }
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
            # Carry-forward fields for the editDetails op: OrderInput's
            # shippingAddress OVERWRITES, so a save that omits these nulls the
            # recipient name / company / region on the address. Read here so
            # the modal can show what it is about to preserve.
            firstName
            lastName
            company
            provinceCode
            countryCodeV2
          }
          billingAddress {
            name
            address1
            phone
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customAttributes {
            key
            value
          }
          deliveryDate: metafield(namespace: "delivery", key: "date") {
            value
          }
          deliveryTimeSlot: metafield(namespace: "delivery", key: "time_slot") {
            value
          }
          customDate: metafield(namespace: "custom", key: "date") {
            value
          }
          customTimeSlot: metafield(namespace: "custom", key: "time_slot") {
            value
          }
          rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
            value
            jsonValue
          }
          rescheduleStatus: metafield(namespace: "$app", key: "reschedule_status") {
            value
          }
          fulfillments(first: 5) {
            createdAt
            deliveredAt
          }
          lineItems(first: 10) {
            edges {
              node {
                name
                quantity
                sku
                image {
                  url
                  altText
                }
                product {
                  title
                  featuredImage {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

// ─── Recent reschedules (the "Rescheduled today" banner, 2026-09-04) ──────────
//
// A second, small query per load: orders tagged `resched-<day>` for the last
// three shop-local days (query string built in lib/recent-reschedules). It is
// separate from GET_ORDERS_QUERY on purpose — the banner must show on EVERY
// tab, and the rescheduled order has usually just left the tab being viewed.
export const RECENT_RESCHEDULE_PAGE = 50;

export const GET_RECENT_RESCHEDULES_QUERY = `
  query GetRecentReschedules($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          tags
          customer {
            id
            firstName
            lastName
            numberOfOrders
            defaultEmailAddress {
              emailAddress
            }
            defaultPhoneNumber {
              phoneNumber
            }
          }
          customAttributes {
            key
            value
          }
          customDate: metafield(namespace: "custom", key: "date") {
            value
          }
          customTimeSlot: metafield(namespace: "custom", key: "time_slot") {
            value
          }
          rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
            value
            jsonValue
          }
          rescheduleSeenAt: metafield(namespace: "$app", key: "reschedule_seen_at") {
            value
          }
        }
      }
    }
  }
`;

// Banner garnish, never page-critical: every failure degrades to "no banner".
export async function fetchRecentRescheduleOrders(
  admin: AdminGraphQLClient,
  todayISO: string,
): Promise<Order[]> {
  const query = buildRecentRescheduleSearchQuery(todayISO);
  if (!query) return [];
  try {
    const response = await admin.graphql(GET_RECENT_RESCHEDULES_QUERY, {
      variables: { first: RECENT_RESCHEDULE_PAGE, query },
    });
    const body = (await response.json()) as {
      data?: { orders?: { edges?: Array<{ node: Order }> } };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      console.warn(
        `[orders loader] recent reschedules skipped: ${body.errors
          .map((e) => e.message)
          .join("; ")}`,
      );
      return [];
    }
    return body.data?.orders?.edges?.map((edge) => edge.node) ?? [];
  } catch (error) {
    console.warn(
      `[orders loader] recent reschedules skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

// ─── Runtime safety helpers ───────────────────────────────────────────────────

export function isIsoDateParam(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Sort options (IndexFilters). Only the CREATED_AT direction is server-side —
// the Admin API has no metafield sort key, so the deliveryDate options keep
// the server default order and are sorted client-side on the loaded page.
export const SORT_PARAM_VALUES = new Set([
  "orderDate asc",
  "orderDate desc",
  "deliveryDate asc",
  "deliveryDate desc",
]);
export const DEFAULT_SORT = "orderDate desc";

// ─── URL params → orders query ────────────────────────────────────────────────

export interface OrdersViewParams {
  deliveryDateParam: string | null;
  searchParam: string;
  timeWindowParam: string;
  tabParam: string;
  sortParam: string;
  after: string | null;
  before: string | null;
}

export function parseOrdersViewParams(
  searchParams: URLSearchParams,
): OrdersViewParams {
  const rawDeliveryDateParam = searchParams.get("deliveryDate");
  const deliveryDateParam = isIsoDateParam(rawDeliveryDateParam)
    ? rawDeliveryDateParam
    : null;

  const searchParam = searchParams.get("search")?.trim() ?? "";
  const timeWindowParam = searchParams.get("timeWindow")?.trim() ?? "";
  const tabParam = searchParams.get("tab") ?? "all";
  const rawSortParam = searchParams.get("sort")?.trim() ?? "";
  const sortParam = SORT_PARAM_VALUES.has(rawSortParam)
    ? rawSortParam
    : DEFAULT_SORT;

  const after = searchParams.get("after") || null;
  const before = searchParams.get("before") || null;

  return {
    deliveryDateParam,
    searchParam,
    timeWindowParam,
    tabParam,
    sortParam,
    after,
    before,
  };
}

/** Views whose rows are narrowed client-side (dated tabs, date or slot filter). */
export function isClientFilteredView(
  tabParam: string,
  deliveryDate: string | null,
  timeWindow: string,
): boolean {
  return (
    tabParam === "today" ||
    tabParam === "yesterday" ||
    tabParam === "tomorrow" ||
    tabParam === "thisWeek" ||
    tabParam === "lastWeek" ||
    Boolean(deliveryDate) ||
    Boolean(timeWindow)
  );
}

export interface OrdersQueryVariables {
  first: number | null;
  after: string | null;
  last: number | null;
  before: string | null;
  query: string | null;
  reverse: boolean;
}

export interface OrdersQueryPlan {
  variables: OrdersQueryVariables;
  /** 250 on client-filtered views, otherwise 25. */
  pageSize: number;
  /** True when a delivery-date tag term scoped the query. */
  dateScoped: boolean;
}

export function buildOrdersQueryPlan(
  view: OrdersViewParams,
  todayISO: string,
): OrdersQueryPlan {
  const { searchParam, tabParam, deliveryDateParam, timeWindowParam, sortParam } =
    view;

  // Metafield search terms are not sent: Shopify ignores them on the orders
  // query unless the definition is indexed as filterable. Delivery-date tags
  // are exact-match searchable; the time-slot filter runs client-side.
  const queryParts: string[] = [];

  if (searchParam) {
    // A raw ":" parses as a field:value operator, so such input is quoted
    // to search as a literal term.
    queryParts.push(
      searchParam.includes(":")
        ? `"${searchParam.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : searchParam,
    );
  }
  if (tabParam === "unfulfilled") {
    queryParts.push("fulfillment_status:unfulfilled status:open");
  } else if (tabParam === "unpaid") {
    queryParts.push(
      "(financial_status:pending OR financial_status:authorized OR financial_status:partially_paid) status:open",
    );
  } else if (tabParam === "archived") {
    queryParts.push("status:closed");
  } else {
    // -status:closed hides archived orders but keeps cancelled ones.
    queryParts.push("-status:closed");
  }

  const dateRefs = computeDateRefs(todayISO);
  const tabDates =
    tabParam === "today"
      ? [dateRefs.todayISO]
      : tabParam === "yesterday"
        ? [dateRefs.yesterdayISO]
        : tabParam === "tomorrow"
          ? [dateRefs.tomorrowISO]
          : tabParam === "thisWeek"
            ? enumerateISODates(dateRefs.startWeekISO, dateRefs.endWeekISO)
            : tabParam === "lastWeek"
              ? enumerateISODates(dateRefs.lastWeekStartISO, dateRefs.lastWeekEndISO)
              : [];
  const tabDateTerm = buildDeliveryDateTagQuery(tabDates);
  if (tabDateTerm) queryParts.push(tabDateTerm);
  const filterDateTerm = deliveryDateParam
    ? buildDeliveryDateTagQuery([deliveryDateParam])
    : "";
  if (filterDateTerm) queryParts.push(filterDateTerm);
  const dateScoped = Boolean(tabDateTerm || filterDateTerm);

  const compositeQuery = queryParts.join(" ") || null;

  const needsClientFilter = isClientFilteredView(
    tabParam,
    deliveryDateParam,
    timeWindowParam,
  );
  const pageSize = needsClientFilter ? 250 : 25;

  const { after, before } = view;
  return {
    variables: {
      first: before ? null : pageSize,
      after,
      last: before ? pageSize : null,
      before,
      query: compositeQuery,
      reverse: sortParam !== "orderDate asc",
    },
    pageSize,
    dateScoped,
  };
}

// ─── Client-side view shaping ─────────────────────────────────────────────────

export interface DisplayedOrdersView {
  tabParam: string;
  deliveryDateFilter: string;
  timeWindowParam: string;
  sortParam: string;
}

/** Applies the dated tab, the date and slot filters, and the delivery-date sort to the loaded page. */
export function selectDisplayedOrders(
  orders: Order[],
  view: DisplayedOrdersView,
  dateRefs: DateRefs,
): Order[] {
  const { tabParam, deliveryDateFilter, timeWindowParam, sortParam } = view;
  let list = orders;
  if (tabParam === "today") {
    list = list.filter(
      (order) => getDeliveryDateValue(order) === dateRefs.todayISO,
    );
  } else if (tabParam === "yesterday") {
    list = list.filter(
      (order) => getDeliveryDateValue(order) === dateRefs.yesterdayISO,
    );
  } else if (tabParam === "tomorrow") {
    list = list.filter(
      (order) => getDeliveryDateValue(order) === dateRefs.tomorrowISO,
    );
  } else if (tabParam === "thisWeek") {
    list = list.filter((order) => {
      const d = getDeliveryDateValue(order);
      return (
        d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
      );
    });
  } else if (tabParam === "lastWeek") {
    list = list.filter((order) => {
      const d = getDeliveryDateValue(order);
      return (
        d !== "—" &&
        d >= dateRefs.lastWeekStartISO &&
        d <= dateRefs.lastWeekEndISO
      );
    });
  }
  if (deliveryDateFilter) {
    list = list.filter(
      (order) => getDeliveryDateValue(order) === deliveryDateFilter,
    );
  }
  if (timeWindowParam) {
    list = list.filter(
      (order) => getDeliveryTimeValue(order) === timeWindowParam,
    );
  }
  if (sortParam === "deliveryDate asc" || sortParam === "deliveryDate desc") {
    const dir = sortParam.endsWith("asc") ? 1 : -1;
    list = [...list].sort((a, b) => {
      const da = getDeliveryDateValue(a);
      const db = getDeliveryDateValue(b);
      if (da === "—" && db === "—") return 0;
      if (da === "—") return 1; // undated orders always sink to the bottom
      if (db === "—") return -1;
      return da < db ? -dir : da > db ? dir : 0;
    });
  }
  return list;
}

export interface OrdersTabCounts {
  today: number;
  yesterday: number;
  tomorrow: number;
  thisWeek: number;
  lastWeek: number;
  unfulfilled: number;
  unpaid: number;
}

export function computeTabCounts(
  orders: Order[],
  dateRefs: DateRefs,
): OrdersTabCounts {
  return {
    today: orders.filter((o) => getDeliveryDateValue(o) === dateRefs.todayISO)
      .length,
    yesterday: orders.filter(
      (o) => getDeliveryDateValue(o) === dateRefs.yesterdayISO,
    ).length,
    tomorrow: orders.filter(
      (o) => getDeliveryDateValue(o) === dateRefs.tomorrowISO,
    ).length,
    thisWeek: orders.filter((o) => {
      const d = getDeliveryDateValue(o);
      return (
        d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
      );
    }).length,
    lastWeek: orders.filter((o) => {
      const d = getDeliveryDateValue(o);
      return (
        d !== "—" &&
        d >= dateRefs.lastWeekStartISO &&
        d <= dateRefs.lastWeekEndISO
      );
    }).length,
    unfulfilled: orders.filter(
      (o) =>
        !o.cancelledAt &&
        o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
    ).length,
    unpaid: orders.filter((o) => isUnpaidStatus(o.displayFinancialStatus))
      .length,
  };
}

export interface OrdersTabDef {
  id: string;
  label: string;
  /** Null renders the label without a count. */
  count: number | null;
  /** True when further server pages exist — the count renders as "N+". */
  approximate?: boolean;
}

export interface OrdersTabDefsInput {
  orders: Order[];
  tabCounts: OrdersTabCounts;
  tabParam: string;
  pageSize: number;
  dateScoped: boolean;
  pageInfo: PageInfo | null;
}

/** Counts show only on a 250-row page; a date-scoped page counts only its own tab. */
export function buildOrdersTabDefs({
  orders,
  tabCounts,
  tabParam,
  pageSize,
  dateScoped,
  pageInfo,
}: OrdersTabDefsInput): OrdersTabDef[] {
  const tabCountsVisible = pageSize >= 250;
  const tabCountsPartial = Boolean(
    pageInfo?.hasNextPage || pageInfo?.hasPreviousPage,
  );
  const tabCount = (id: string, n: number): number | null => {
    if (!tabCountsVisible) return null;
    if (dateScoped && id !== tabParam) return null;
    return n;
  };
  return [
    { id: "all", label: "All", count: tabCount("all", orders.length), approximate: tabCountsPartial },
    { id: "today", label: "Today", count: tabCount("today", tabCounts.today), approximate: tabCountsPartial },
    { id: "tomorrow", label: "Tomorrow", count: tabCount("tomorrow", tabCounts.tomorrow), approximate: tabCountsPartial },
    { id: "thisWeek", label: "This week", count: tabCount("thisWeek", tabCounts.thisWeek), approximate: tabCountsPartial },
    { id: "yesterday", label: "Yesterday", count: tabCount("yesterday", tabCounts.yesterday), approximate: tabCountsPartial },
    { id: "lastWeek", label: "Last week", count: tabCount("lastWeek", tabCounts.lastWeek), approximate: tabCountsPartial },
    { id: "unfulfilled", label: "Unfulfilled", count: tabCount("unfulfilled", tabCounts.unfulfilled), approximate: tabCountsPartial },
    { id: "unpaid", label: "Unpaid", count: tabCount("unpaid", tabCounts.unpaid), approximate: tabCountsPartial },
    { id: "archived", label: "Archived", count: null },
  ];
}

// ─── KPIs (this page only) ────────────────────────────────────────────────────

export interface OrderKpis {
  kpiOrderCount: number;
  kpiRevenue: string;
  kpiAvgRevenue: string;
  kpiUnpaidCount: number;
  kpiUnpaidTotal: string;
  kpiUnfulfilledCount: number;
  kpiUnfulfilledDueToday: number;
  kpiProducts: [string, number][];
  kpiDeliveryFees: string;
}

export function computeOrderKpis(
  displayedOrders: Order[],
  todayISO: string,
): OrderKpis {
  const kpiOrderCount: number = displayedOrders.length;

  const { kpiRevenue, kpiAvgRevenue } = (() => {
    if (displayedOrders.length === 0)
      return { kpiRevenue: "—", kpiAvgRevenue: "" };
    let total = 0,
      currency = "",
      count = 0;
    for (const o of displayedOrders) {
      if (o.currentTotalPriceSet?.shopMoney) {
        total += parseFloat(o.currentTotalPriceSet.shopMoney.amount) || 0;
        if (!currency) currency = o.currentTotalPriceSet.shopMoney.currencyCode;
        count++;
      }
    }
    if (!currency) return { kpiRevenue: "—", kpiAvgRevenue: "" };
    const avg =
      count > 0
        ? (total / count).toLocaleString("en-US", {
            style: "currency",
            currency,
            maximumFractionDigits: 0,
          })
        : "";
    return {
      kpiRevenue: total.toLocaleString("en-US", {
        style: "currency",
        currency,
      }),
      kpiAvgRevenue: avg ? `Avg ${avg} / order` : "",
    };
  })();

  const { kpiUnpaidCount, kpiUnpaidTotal } = (() => {
    let total = 0,
      currency = "";
    const count = displayedOrders.filter((o) => {
      const match = isUnpaidStatus(o.displayFinancialStatus);
      if (match && o.currentTotalPriceSet?.shopMoney) {
        total += parseFloat(o.currentTotalPriceSet.shopMoney.amount) || 0;
        if (!currency) currency = o.currentTotalPriceSet.shopMoney.currencyCode;
      }
      return match;
    }).length;
    const totalStr =
      currency && total > 0
        ? total.toLocaleString("en-US", { style: "currency", currency })
        : "";
    return {
      kpiUnpaidCount: count,
      kpiUnpaidTotal: totalStr ? `${totalStr} pending` : "",
    };
  })();

  // Cancelled orders keep UNFULFILLED as their fulfillment status and are
  // excluded here.
  const kpiUnfulfilledCount = displayedOrders.filter(
    (o) =>
      !o.cancelledAt &&
      o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
  ).length;
  const kpiUnfulfilledDueToday = displayedOrders.filter((o) => {
    if (o.cancelledAt) return false;
    if (o.displayFulfillmentStatus?.toUpperCase() !== "UNFULFILLED")
      return false;
    const d = getDeliveryDateValue(o);
    return d !== "—" && d <= todayISO;
  }).length;

  const kpiProducts = (() => {
    if (displayedOrders.length === 0) return [] as [string, number][];
    const productMap = new Map<string, number>();
    for (const o of displayedOrders) {
      if (o.cancelledAt) continue;
      const items = o.lineItems?.edges || [];
      for (const item of items) {
        const qty = item.node.quantity || 0;
        if (item.node.name) {
          const name = item.node.name;
          productMap.set(name, (productMap.get(name) || 0) + qty);
        }
      }
    }
    return Array.from(productMap.entries()).sort((a, b) => b[1] - a[1]);
  })();

  const kpiDeliveryFees = (() => {
    let total = 0,
      currency = "";
    for (const o of displayedOrders) {
      const money = o.totalShippingPriceSet?.shopMoney;
      if (money) {
        total += parseFloat(money.amount);
        if (!currency) currency = money.currencyCode;
      }
    }
    if (!currency) return "—";
    return total.toLocaleString("en-US", {
      style: "currency",
      currency,
    });
  })();

  return {
    kpiOrderCount,
    kpiRevenue,
    kpiAvgRevenue,
    kpiUnpaidCount,
    kpiUnpaidTotal,
    kpiUnfulfilledCount,
    kpiUnfulfilledDueToday,
    kpiProducts,
    kpiDeliveryFees,
  };
}

// ─── Search hits hidden by a client-side filter ──────────────────────────────

export interface HiddenSearchMatch {
  id: string;
  name: string;
  when: string;
}

/** Up to three loaded orders a search matched but the dated tab or date/slot filter hid. */
export function findHiddenSearchMatches(
  orders: Order[],
  displayedCount: number,
  view: { searchParam: string; tabParam: string; deliveryDateFilter: string; timeWindowParam: string },
): HiddenSearchMatch[] {
  if (!view.searchParam || displayedCount > 0) return [];
  if (
    !isClientFilteredView(
      view.tabParam,
      view.deliveryDateFilter,
      view.timeWindowParam,
    )
  )
    return [];
  return orders.slice(0, 3).map((o) => {
    const date = getDeliveryDateValue(o);
    const slot = getDeliveryTimeValue(o);
    const when = [
      date !== "—" ? formatDeliveryDate(date) : "",
      slot !== "—" ? slot : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return { id: o.id, name: o.name, when: when || "no delivery date" };
  });
}

/** Sorted union of the selected orders' meaningful tags. */
export function collectSelectedTags(
  displayedOrders: Order[],
  selectedIds: string[],
): string[] {
  const set = new Set<string>();
  for (const o of displayedOrders) {
    if (!selectedIds.includes(o.id)) continue;
    for (const tag of getMeaningfulTags(o.tags || [])) set.add(tag);
  }
  return Array.from(set).sort();
}
