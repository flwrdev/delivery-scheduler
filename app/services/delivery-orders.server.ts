import type { AdminGraphQLClient } from "./delivery-bookings.server";
import {
  getDeliveryDate as getLegacyDeliveryDate,
  getTimeSlot as getLegacyTimeSlot,
  normalizeDeliveryDateValue,
  normalizeDeliveryTimeSlotValue,
} from "./delivery-bookings.server";

interface AdminGraphQLResponseError {
  message: string;
}

interface MoneyV2 {
  amount: string;
  currencyCode: string;
}

interface MoneyBag {
  shopMoney?: MoneyV2 | null;
}

interface OrderAttribute {
  key: string;
  value: string;
}

interface MetafieldValue {
  value?: string | null;
}

interface ShippingAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

interface OrderCustomer {
  displayName?: string | null;
  email?: string | null;
}

interface LineItemNode {
  title?: string | null;
  quantity?: number | null;
  sku?: string | null;
}

interface OrderNode {
  id: string;
  name: string;
  cancelledAt?: string | null;
  email?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currentTotalPriceSet?: MoneyBag | null;
  totalShippingPriceSet?: MoneyBag | null;
  customer?: OrderCustomer | null;
  customAttributes: OrderAttribute[];
  tags: string[];
  deliveryDateMetafield?: MetafieldValue | null;
  timeSlotMetafield?: MetafieldValue | null;
  shippingAddress?: ShippingAddress | null;
  phone?: string | null;
  note?: string | null;
  lineItems?: { edges: Array<{ node: LineItemNode }> } | null;
}

interface DashboardOrdersQueryResponse {
  data?: {
    orders?: {
      edges: Array<{ cursor: string; node: OrderNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: AdminGraphQLResponseError[];
}

export interface DashboardDeliveryOrderRow {
  id: string;
  name: string;
  customerName: string;
  customerEmail: string;
  itemsSummary: string;
  total: { amount: string; currencyCode: string } | null;
  shippingPrice: { amount: string; currencyCode: string } | null;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  deliveryDate: string | null;
  timeSlot: string | null;
  destination: string;
  phone: string | null;
  /** Order note from Shopify admin */
  note: string | null;
  /** All non-empty cart / custom attributes (for copy summary) */
  cartAttributes: Array<{ key: string; value: string }>;
}

export interface DashboardDeliveryOrdersResult {
  rows: DashboardDeliveryOrderRow[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  pageSize: number;
  /** True when Shopify had more orders than the fetch window — post-filter results may not be exhaustive. */
  isTruncated: boolean;
  error: string | null;
  appliedDateFilter: string;
  appliedTimeSlot: string | null;
}

const DASHBOARD_ORDERS_QUERY = `#graphql
  query DashboardDeliveryOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          cancelledAt
          email
          displayFinancialStatus
          displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          customer { displayName email }
          customAttributes { key value }
          tags
          deliveryDateMetafield: metafield(namespace: "custom", key: "date") { value }
          timeSlotMetafield: metafield(namespace: "custom", key: "time_slot") { value }
          shippingAddress { address1 address2 city province zip country phone }
          phone
          note
          lineItems(first: 10) {
            edges {
              node { title quantity sku }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const DEFAULT_LOOKBACK_DAYS = 90;
const DELIVERY_DATE_TAG_PREFIX = "delivery-date:";
const DELIVERY_TIME_TAG_PREFIX = "delivery-time:";

function getPastDateString(timezone: string, daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
}

function getTodayString(timezone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

function extractGraphQLErrorMessage(errors: AdminGraphQLResponseError[] | undefined, fallback: string) {
  if (!errors?.length) return fallback;
  return errors.map((error) => error.message).join(", ");
}

// Pull date/time slot from explicit dashboard tag prefixes before deferring to the
// shared legacy helpers, which already handle attribute and bare-tag formats.
function getDeliveryDateFromPrefixedTag(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.toLowerCase().startsWith(DELIVERY_DATE_TAG_PREFIX)) {
      const normalized = normalizeDeliveryDateValue(tag.slice(DELIVERY_DATE_TAG_PREFIX.length));
      if (normalized) return normalized;
    }
  }
  return null;
}

function getTimeSlotFromPrefixedTag(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.toLowerCase().startsWith(DELIVERY_TIME_TAG_PREFIX)) {
      const normalized = normalizeDeliveryTimeSlotValue(tag.slice(DELIVERY_TIME_TAG_PREFIX.length));
      if (normalized) return normalized;
    }
  }
  return null;
}

function resolveDeliveryDate(node: OrderNode): string | null {
  const metafieldValue = node.deliveryDateMetafield?.value?.trim();
  if (metafieldValue) {
    const normalized = normalizeDeliveryDateValue(metafieldValue);
    if (normalized) return normalized;
  }

  // Reuse legacy attribute → bare-tag parsing so older orders still resolve correctly.
  const legacy = getLegacyDeliveryDate({
    cancelledAt: node.cancelledAt ?? null,
    customAttributes: node.customAttributes ?? [],
    tags: node.tags ?? [],
  });
  if (legacy) return legacy;

  return getDeliveryDateFromPrefixedTag(node.tags ?? []);
}

function resolveTimeSlot(node: OrderNode): string | null {
  const metafieldValue = node.timeSlotMetafield?.value?.trim();
  if (metafieldValue) {
    const normalized = normalizeDeliveryTimeSlotValue(metafieldValue);
    if (normalized) return normalized;
  }

  const legacy = getLegacyTimeSlot({
    cancelledAt: node.cancelledAt ?? null,
    customAttributes: node.customAttributes ?? [],
    tags: node.tags ?? [],
  });
  if (legacy) return legacy;

  return getTimeSlotFromPrefixedTag(node.tags ?? []);
}

function buildItemsSummary(node: OrderNode): string {
  const edges = node.lineItems?.edges ?? [];
  if (!edges.length) return "—";

  const parts = edges
    .map((edge) => {
      const title = edge.node.title?.trim() || "Item";
      const quantity = Number(edge.node.quantity) || 0;
      return quantity > 1 ? `${title} × ${quantity}` : title;
    })
    .filter(Boolean);

  const visible = parts.slice(0, 2).join(", ");
  const extra = parts.length > 2 ? ` +${parts.length - 2} more` : "";
  return `${visible}${extra}`;
}

function buildDestination(address: ShippingAddress | null | undefined): string {
  if (!address) return "—";
  const street = [address.address1, address.address2]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .join(" ");
  const cityLine = [address.city, address.province]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .join(", ");
  const parts = [street, cityLine].filter((v) => v.length > 0);
  return parts.length ? parts.join(", ") : "—";
}

function buildShippingPrice(node: OrderNode) {
  const money = node.totalShippingPriceSet?.shopMoney;
  if (!money?.amount || !money?.currencyCode) return null;
  return { amount: money.amount, currencyCode: money.currencyCode };
}

function buildCustomerName(node: OrderNode): string {
  const display = node.customer?.displayName?.trim();
  if (display) return display;
  const email = node.customer?.email?.trim() || node.email?.trim();
  return email || "Guest";
}

function buildCustomerEmail(node: OrderNode): string {
  return node.customer?.email?.trim() || node.email?.trim() || "";
}

function buildTotal(node: OrderNode) {
  const money = node.currentTotalPriceSet?.shopMoney;
  if (!money?.amount || !money?.currencyCode) return null;
  return { amount: money.amount, currencyCode: money.currencyCode };
}

function clampPageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.floor(value as number), 1), MAX_PAGE_SIZE);
}

export interface LoadDashboardDeliveryOrdersOptions {
  timezone?: string;
  pageSize?: number;
  after?: string | null;
  lookbackDays?: number;
  /** "upcoming" (default) or a YYYY-MM-DD string for exact-date server-side filtering. */
  deliveryDate?: string | null;
  /** Exact time-slot value to filter, e.g. "9AM-12PM". Null = all slots. */
  timeSlot?: string | null;
}

export async function loadDashboardDeliveryOrders(
  admin: AdminGraphQLClient,
  options: LoadDashboardDeliveryOrdersOptions = {},
): Promise<DashboardDeliveryOrdersResult> {
  // Fail open: callers render the rest of the dashboard if this throws.
  const pageSize = clampPageSize(options.pageSize);
  const timezone = options.timezone || "UTC";
  const lookbackDays = Math.max(1, options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
  const after = typeof options.after === "string" && options.after ? options.after : null;

  const deliveryDateFilter =
    typeof options.deliveryDate === "string" && options.deliveryDate
      ? options.deliveryDate
      : "upcoming";
  const timeSlotFilter =
    typeof options.timeSlot === "string" && options.timeSlot ? options.timeSlot : null;

  const today = getTodayString(timezone);
  const isExactDate = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDateFilter);

  // For exact dates, push metafields.custom.date filter to Shopify so the query is
  // narrowed server-side. Legacy orders (date in customAttributes/tags) are then
  // caught by the post-filter below.
  let filterQuery = `created_at:>=${getPastDateString(timezone, lookbackDays)}`;
  if (isExactDate) {
    filterQuery = `${filterQuery} metafields.custom.date:${deliveryDateFilter}`;
  }

  const response = await admin.graphql(DASHBOARD_ORDERS_QUERY, {
    variables: { first: pageSize, after, query: filterQuery },
  });

  const responseJson = (await response.json()) as DashboardOrdersQueryResponse;
  if (!response.ok || responseJson.errors?.length) {
    throw new Error(
      extractGraphQLErrorMessage(responseJson.errors, "Failed to load delivery orders."),
    );
  }

  const orders = responseJson.data?.orders;
  if (!orders) {
    return {
      rows: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      pageSize,
      isTruncated: false,
      error: null,
      appliedDateFilter: deliveryDateFilter,
      appliedTimeSlot: timeSlotFilter,
    };
  }

  const rows: DashboardDeliveryOrderRow[] = [];
  for (const edge of orders.edges) {
    const node = edge.node;
    if (node.cancelledAt) continue;

    rows.push({
      id: node.id,
      name: node.name,
      customerName: buildCustomerName(node),
      customerEmail: buildCustomerEmail(node),
      itemsSummary: buildItemsSummary(node),
      total: buildTotal(node),
      shippingPrice: buildShippingPrice(node),
      paymentStatus: node.displayFinancialStatus ?? null,
      fulfillmentStatus: node.displayFulfillmentStatus ?? null,
      deliveryDate: resolveDeliveryDate(node),
      timeSlot: resolveTimeSlot(node),
      destination: buildDestination(node.shippingAddress),
      phone:
        node.shippingAddress?.phone?.trim() ||
        node.phone?.trim() ||
        null,
      note: node.note?.trim() || null,
      cartAttributes: (node.customAttributes ?? []).filter(
        (a) => typeof a.value === "string" && a.value.trim().length > 0,
      ),
    });
  }

  // Server-side post-filtering (still in loader, not in browser).
  let filteredRows = rows;
  if (deliveryDateFilter === "upcoming") {
    filteredRows = filteredRows.filter(
      (r) => r.deliveryDate != null && r.deliveryDate >= today,
    );
    // Sort ascending by delivery date so nearest deliveries appear first.
    filteredRows.sort((a, b) =>
      (a.deliveryDate ?? "9999-99-99").localeCompare(b.deliveryDate ?? "9999-99-99"),
    );
  } else if (isExactDate) {
    // The metafield query handled most orders. Also catch legacy attribute/tag orders.
    filteredRows = filteredRows.filter((r) => r.deliveryDate === deliveryDateFilter);
  }

  if (timeSlotFilter) {
    filteredRows = filteredRows.filter((r) => r.timeSlot === timeSlotFilter);
  }

  return {
    rows: filteredRows,
    pageInfo: {
      hasNextPage: Boolean(orders.pageInfo.hasNextPage),
      endCursor: orders.pageInfo.endCursor ?? null,
    },
    pageSize,
    isTruncated: Boolean(orders.pageInfo.hasNextPage),
    error: null,
    appliedDateFilter: deliveryDateFilter,
    appliedTimeSlot: timeSlotFilter,
  };
}
