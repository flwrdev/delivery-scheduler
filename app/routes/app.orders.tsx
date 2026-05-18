import { useState, useCallback, useMemo, useEffect } from "react";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useFetcher,
  useNavigation,
} from "react-router";
import { authenticate } from "../shopify.server";
import stylesHref from "../styles/orders-dashboard.css?url";

export const links = () => [{ rel: "stylesheet", href: stylesHref }];

// ─── Sorting ─────────────────────────────────────────────────────────────────

type SortableColumn = "city" | "timeWindow" | "deliveryDate" | "fulfillment";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortableColumn | null;
  direction: SortDirection;
}

const FULFILLMENT_ORDER: Record<string, number> = {
  UNFULFILLED: 0,
  ON_HOLD: 1,
  SCHEDULED: 2,
  IN_PROGRESS: 3,
  PARTIALLY_FULFILLED: 4,
  FULFILLED: 5,
  RESTOCKED: 6,
};

const DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "items",
  "customer",
  "city",
  "payment",
  "fulfillment",
  "deliveryDate",
  "timeWindow",
  "total",
  "actions",
];

const MOBILE_VISIBLE_COLUMNS = [
  "name",
  "customer",
  "city",
  "deliveryDate",
  "timeWindow",
  "fulfillment",
  "actions",
];

function parseTimeWindowHour(tw: string): number {
  if (!tw || tw === "—") return 999;
  const colonMatch = tw.match(/^(\d{1,2}):(\d{2})/);
  if (colonMatch) return parseInt(colonMatch[1], 10);
  const ampmMatch = tw.match(/(\d{1,2})\s*(am|pm)/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const period = ampmMatch[2].toLowerCase();
    if (period === "pm" && h !== 12) h += 12;
    if (period === "am" && h === 12) h = 0;
    return h;
  }
  return 999;
}

function parseDateValue(raw: string | null | undefined): number {
  if (!raw) return Infinity;
  const parts = raw.split("-");
  if (parts.length !== 3) return Infinity;
  return new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  ).getTime();
}

function toLocalISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmailAddress {
  emailAddress: string;
}

interface PhoneNumber {
  phoneNumber: string;
}

interface Customer {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: EmailAddress | null;
  defaultPhoneNumber: PhoneNumber | null;
}

interface Metafield {
  value: string;
}

interface ShippingAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
}

interface CustomAttribute {
  key: string;
  value: string | null;
}

interface LineItemImage {
  url: string;
  altText: string | null;
}

interface LineItemProduct {
  title: string;
  featuredImage: LineItemImage | null;
}

interface LineItem {
  name: string;
  quantity: number;
  sku: string | null;
  image: LineItemImage | null;
  product: LineItemProduct | null;
}

interface Order {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  displayFinancialStatus: string;
  tags: string[];
  customer: Customer | null;
  deliveryDate: Metafield | null;
  deliveryTimeSlot: Metafield | null;
  customDate: Metafield | null;
  customTimeSlot: Metafield | null;
  shippingAddress: ShippingAddress | null;
  note: string | null;
  currentTotalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  customAttributes: CustomAttribute[];
  lineItems: { edges: { node: LineItem }[] } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

// ─── GraphQL Query ────────────────────────────────────────────────────────────

const GET_ORDERS_QUERY = `
  query GetOrdersTable(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $query: String
  ) {
    orders(
      first: $first
      after: $after
      last: $last
      before: $before
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          tags
          note
          customer {
            id
            firstName
            lastName
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
          }
          currentTotalPriceSet {
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

// ─── Badge helpers ────────────────────────────────────────────────────────────

type BadgeTone =
  | "success"
  | "warning"
  | "critical"
  | "info"
  | "caution"
  | "neutral";

function financialStatusTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (s === "paid") return "neutral";
  if (s === "pending" || s === "authorized") return "caution";
  if (s === "partially_paid") return "warning";
  if (s === "refunded" || s === "partially_refunded" || s === "voided")
    return "neutral";
  return "neutral";
}

function isUnpaidStatus(status: string): boolean {
  return new Set(["pending", "authorized", "partially_paid"]).has(
    (status || "").toLowerCase(),
  );
}

function fulfillmentStatusTone(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (s === "FULFILLED") return "neutral";
  if (s === "PARTIALLY_FULFILLED") return "warning";
  if (s === "IN_PROGRESS") return "info";
  if (s === "UNFULFILLED" || s === "ON_HOLD" || s === "SCHEDULED")
    return "caution";
  if (s === "RESTOCKED") return "neutral";
  return "neutral";
}

function isOpenFulfillmentStatus(status: string): boolean {
  return new Set(["UNFULFILLED", "ON_HOLD", "SCHEDULED"]).has(
    (status || "").toUpperCase(),
  );
}

function formatStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Date formatters ─────────────────────────────────────────────────────────

function formatDeliveryDate(raw: string): string {
  const parts = raw.split("-");
  if (parts.length !== 3) return raw;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const d = new Date(year, month, day);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatMoney(amount: string, currencyCode: string): string {
  const num = parseFloat(amount);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: currencyCode,
  });
}

// ─── Filter Helpers ──────────────────────────────────────────────────────────

function normalizeDateToISO(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const ymdMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdMatch) return `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dy = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${dy}`;
  }
  return null;
}

function normalizeTimeSlot(value: string): string {
  if (!value) return "";
  let s = value.trim();
  // Strip label prefixes — keep from first digit
  const firstDigit = s.search(/\d/);
  if (firstDigit > 0) s = s.slice(firstDigit);
  // Normalize en-dash and em-dash to hyphen
  s = s.replace(/[–—]/g, "-");
  // Strip all whitespace
  s = s.replace(/\s+/g, "");
  // Strip :00 (e.g. "9:00AM" → "9AM", "12:00PM" → "12PM")
  s = s.replace(/:00/g, "");
  // Uppercase for consistent comparison
  return s.toUpperCase();
}

// Regex patterns for tag detection
const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SLOT_RE =
  /^\d{1,2}(:\d{2})?\s*(AM|PM)\s*[-–]\s*\d{1,2}(:\d{2})?\s*(AM|PM)$/i;

// Primary date source: custom.date metafield (reschedule writes here), then delivery.date (order creation), then fallbacks
function getDeliveryDateValue(order: Order): string {
  const attrs = order.customAttributes || [];
  if (order.customDate?.value) return order.customDate.value;
  if (order.deliveryDate?.value) return order.deliveryDate.value;
  const fromAttr = findAttrValue(
    attrs,
    "Delivery Date",
    "delivery.date",
    "sidekick.delivery_date",
  );
  if (fromAttr) return fromAttr;
  const dateTag = (order.tags || []).find((t) => DATE_ISO_RE.test(t.trim()));
  if (dateTag) return dateTag.trim();
  return "—";
}

// Primary time source: custom.time_slot metafield (reschedule writes here), then delivery.time_slot (order creation), then fallbacks
function getDeliveryTimeValue(order: Order): string {
  const attrs = order.customAttributes || [];
  if (order.customTimeSlot?.value) return order.customTimeSlot.value;
  if (order.deliveryTimeSlot?.value) return order.deliveryTimeSlot.value;
  const fromAttr = findAttrValue(
    attrs,
    "Delivery Time",
    "delivery.time_slot",
    "sidekick.delivery_time",
    "Time Slot",
    "time_slot",
    "delivery_time",
  );
  if (fromAttr) return fromAttr;
  const timeTag = (order.tags || []).find((t) => TIME_SLOT_RE.test(t.trim()));
  if (timeTag) return timeTag.trim();
  return "—";
}

// ─── Tag display helpers ────────────────────────────────────────────────────

function isHiddenDateTag(tag: string): boolean {
  const t = tag.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) return true;
  if (/^\d{8}$/.test(t)) return true;
  if (
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}$/i.test(
      t,
    )
  )
    return true;
  if (
    /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}$/i.test(
      t,
    )
  )
    return true;
  return false;
}

function isHiddenTag(tag: string): boolean {
  if (isHiddenDateTag(tag)) return true;
  if (
    /^\d{1,2}(:\d{2})?\s*(AM|PM)\s*[-–]\s*\d{1,2}(:\d{2})?\s*(AM|PM)$/i.test(
      tag.trim(),
    )
  )
    return true;
  return false;
}

function tagDisplayLabel(tag: string): string {
  const lower = tag.toLowerCase().trim();
  if (lower === "ops_md_checked") return "Checked";
  if (lower === "resched") return "Rescheduled";
  return tag.trim();
}

function getMeaningfulTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => !isHiddenTag(t));
}

function getDeliveryRelativeLabel(rawISO: string, todayISO: string): string {
  if (!rawISO || rawISO === "—") return "";
  const todayTs = parseDateValue(todayISO);
  const orderTs = parseDateValue(rawISO);
  if (!isFinite(orderTs)) return "";
  const diffDays = Math.round((orderTs - todayTs) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays > 1) return `In ${diffDays} days`;
  if (diffDays === -1) return "Yesterday";
  return `${Math.abs(diffDays)} days ago`;
}

function isDeliveryOverdue(rawISO: string, todayISO: string): boolean {
  if (!rawISO || rawISO === "—") return false;
  const todayTs = parseDateValue(todayISO);
  const orderTs = parseDateValue(rawISO);
  return isFinite(todayTs) && isFinite(orderTs) && orderTs < todayTs;
}

// ─── Sortable column header ──────────────────────────────────────────────────

interface SortableHeaderProps {
  id: string;
  column: SortableColumn;
  label: string;
  sortState: SortState;
  onSort: (col: SortableColumn) => void;
  listSlot?: TableListSlot;
}

type TableListSlot = "primary" | "secondary" | "kicker" | "inline" | "labeled";

function SortableHeader({
  id,
  column,
  label,
  sortState,
  onSort,
  listSlot,
}: SortableHeaderProps) {
  const isActive: boolean = sortState.column === column;
  const iconType = isActive
    ? sortState.direction === "asc"
      ? "sort-ascending"
      : "sort-descending"
    : "sort";
  return (
    <s-table-header id={id} listSlot={listSlot}>
      <s-button
        id={`sort-btn-${column}`}
        variant="tertiary"
        icon={iconType}
        onClick={() => onSort(column)}
        accessibilityLabel={`Sort by ${label}`}
      >
        {label}
      </s-button>
    </s-table-header>
  );
}

// ─── Custom attribute helpers ─────────────────────────────────────────────────

function getAttr(attrs: CustomAttribute[], ...keys: string[]): string {
  for (const key of keys) {
    const found = attrs.find((a) => a.key === key);
    if (found?.value) return found.value;
  }
  return "—";
}

function findAttrValue(
  attrs: CustomAttribute[],
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const found = attrs.find((a) => a.key === key);
    if (found?.value) return found.value;
  }
  return null;
}

function getCustomerName(order: Order): string {
  return order.customer
    ? [order.customer.firstName, order.customer.lastName]
        .filter(Boolean)
        .join(" ") || "—"
    : "—";
}

function getOrderPhone(order: Order): string {
  return (
    order.customer?.defaultPhoneNumber?.phoneNumber ||
    order.shippingAddress?.phone ||
    "—"
  );
}

function getFullShippingAddress(order: Order): string {
  const addr = order.shippingAddress;
  return addr
    ? [addr.address1, addr.address2].filter(Boolean).join(", ") || "—"
    : "—";
}

function getCity(order: Order): string {
  return order.shippingAddress?.city || "—";
}

function getInstructionValue(order: Order): string {
  const attrs: CustomAttribute[] = order.customAttributes || [];
  return (
    findAttrValue(
      attrs,
      "Instruction",
      "Delivery Instruction",
      "Special Instruction",
      "Special Instructions",
      "Notes",
      "Note",
      "delivery_instruction",
      "instruction",
    ) ||
    order.note ||
    "—"
  );
}

function buildDeliveryInfoText(order: Order): string {
  const attrs: CustomAttribute[] = order.customAttributes || [];
  const customerName = getCustomerName(order);
  const phone = getOrderPhone(order);
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const timeWindow = getDeliveryTimeValue(order);
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  const instruction = getInstructionValue(order);

  return [
    `Customer: ${customerName}`,
    `Phone #: ${phone}`,
    `Address: ${fullAddress}`,
    `City: ${city}`,
    `Delivery date: ${deliveryDate}`,
    `Time window: ${timeWindow}`,
    `Card message: ${cardMessage}`,
    `Instruction: ${instruction}`,
  ].join("\n");
}

function getSearchableOrderText(order: Order): string {
  const fullName = [order.customer?.firstName, order.customer?.lastName]
    .filter(Boolean)
    .join(" ");
  const city = getCity(order);
  const tags = Array.isArray(order.tags) ? order.tags.join(" ") : "";
  const itemNames = (order.lineItems?.edges || [])
    .map((e) => e.node.name)
    .filter(Boolean)
    .join(" ");
  return [
    order.name,
    order.customer?.firstName,
    order.customer?.lastName,
    fullName,
    getOrderPhone(order),
    order.customer?.defaultEmailAddress?.emailAddress,
    city,
    tags,
    itemNames,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// ─── Line item helpers ────────────────────────────────────────────────────────

function getFirstItemImageUrl(order: Order): string | undefined {
  const item = order.lineItems?.edges?.[0]?.node ?? null;
  return item?.image?.url || item?.product?.featuredImage?.url || undefined;
}

function getFirstItemAltText(order: Order): string {
  const item = order.lineItems?.edges?.[0]?.node ?? null;
  if (!item) return "Product image";
  return (
    item.image?.altText ||
    item.product?.featuredImage?.altText ||
    `Image of ${item.name}`
  );
}

// ─── Runtime safety helpers ───────────────────────────────────────────────────

function getSafeEventValue(e: Event): string {
  const t = (e.currentTarget ?? e.target) as
    | (EventTarget & { value?: unknown })
    | null;
  const detailValue = (e as Event & { detail?: { value?: unknown } }).detail
    ?.value;
  return (
    (typeof t?.value === "string" ? t.value : null) ??
    (typeof detailValue === "string" ? detailValue : null) ??
    ""
  );
}

function isIsoDateParam(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpTrackingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

type LoaderData = {
  orders: Order[];
  pageInfo: PageInfo | null;
  errors: Array<{ message: string }> | null;
  deliveryDateParam: string | null;
};

export const loader = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const rawDeliveryDateParam = url.searchParams.get("deliveryDate");
  const deliveryDateParam = isIsoDateParam(rawDeliveryDateParam)
    ? rawDeliveryDateParam
    : null;

  const variables = deliveryDateParam
    ? {
        first: 250,
        after: null,
        last: null,
        before: null,
        query: `metafields.custom.date:${deliveryDateParam}`,
      }
    : { first: 25, after: null, last: null, before: null, query: null };

  const response = await admin.graphql(GET_ORDERS_QUERY, { variables });
  const body = (await response.json()) as {
    data?: {
      orders?: {
        edges?: Array<{ node: Order }>;
        pageInfo?: PageInfo | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  return Response.json({
    orders:
      body.data?.orders?.edges?.map((edge: { node: Order }) => edge.node) ?? [],
    pageInfo: body.data?.orders?.pageInfo ?? null,
    errors: body.errors ?? null,
    deliveryDateParam,
  } satisfies LoaderData);
};

// ─── Bulk action mutations ────────────────────────────────────────────────────

const ORDER_CLOSE_MUTATION = `
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_OPEN_MUTATION = `
  mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// Fulfillment-order workflow — used ONLY when the merchant clicks "Mark as fulfilled".
// Requires read_merchant_managed_fulfillment_orders (query) and
// write_merchant_managed_fulfillment_orders (mutation). Never added to GET_ORDERS_QUERY.
const GET_ORDER_FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          supportedActions { action }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// Rewrite raw Shopify access-denied / scope errors into something the merchant can act on.
function scopeHint(msg: string): string {
  if (
    /access denied|fulfillmentOrders|not authorized|missing.*scope/i.test(msg)
  ) {
    return "Access denied — the app needs fulfillment-order permission. Please reinstall the app to grant the new scope.";
  }
  return msg;
}

// ─── Action result types ──────────────────────────────────────────────────────

type BulkActionName =
  | "archive"
  | "unarchive"
  | "cancel"
  | "tagsAdd"
  | "tagsRemove"
  | "markFulfilled";

const BULK_ACTION_NAMES: readonly BulkActionName[] = [
  "archive",
  "unarchive",
  "cancel",
  "tagsAdd",
  "tagsRemove",
  "markFulfilled",
];
const MAX_SELECTED_ORDER_IDS = 100;
const MAX_TAG_LENGTH = 255;

function isBulkActionName(value: string): value is BulkActionName {
  return (BULK_ACTION_NAMES as readonly string[]).includes(value);
}

interface BulkActionItemResult {
  orderId: string;
  success: boolean;
  message?: string;
}

interface BulkActionResponse {
  ok: boolean;
  action: BulkActionName | null;
  message?: string;
  results: BulkActionItemResult[];
  summary: { ok: number; failed: number };
}

// ─── Action handler ───────────────────────────────────────────────────────────

export const action = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin } = await authenticate.admin(request);
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      {
        ok: false,
        action: null,
        message: "Method not allowed.",
        results: [],
        summary: { ok: 0, failed: 0 },
      } satisfies BulkActionResponse,
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const fd = await request.formData();
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
    return Response.json(
      { ...empty, message: opRaw ? "Unknown action." : "Missing action." },
      { status: 400 },
    );
  }
  if (orderIds.length === 0) {
    return Response.json(empty, { status: 400 });
  }
  if (orderIds.length > MAX_SELECTED_ORDER_IDS) {
    return Response.json(
      {
        ...empty,
        message: `Select ${MAX_SELECTED_ORDER_IDS} or fewer orders at a time.`,
      },
      { status: 400 },
    );
  }

  const results: BulkActionItemResult[] = [];

  const runOne = async (
    id: string,
    mutation: string,
    variables: Record<string, unknown>,
    rootKey: string,
    errorsKey: "userErrors" | "orderCancelUserErrors",
  ) => {
    try {
      const res = await admin.graphql(mutation, { variables });
      const j = (await res.json()) as {
        data?: Record<string, { [k: string]: unknown }>;
        errors?: Array<{ message: string }>;
      };
      if (j.errors?.length) {
        results.push({
          orderId: id,
          success: false,
          message: j.errors.map((e) => e.message).join("; "),
        });
        return;
      }
      const errs =
        (j?.data?.[rootKey]?.[errorsKey] as Array<{ message: string }>) || [];
      if (errs.length) {
        results.push({
          orderId: id,
          success: false,
          message: errs.map((e) => e.message).join("; "),
        });
      } else {
        results.push({ orderId: id, success: true });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "GraphQL error";
      results.push({ orderId: id, success: false, message });
    }
  };

  if (op === "archive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_CLOSE_MUTATION,
        { input: { id } },
        "orderClose",
        "userErrors",
      );
    }
  } else if (op === "unarchive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_OPEN_MUTATION,
        { input: { id } },
        "orderOpen",
        "userErrors",
      );
    }
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
    const staffNote = staffNoteRaw.trim() || null;
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_CANCEL_MUTATION,
        { orderId: id, reason, restock, notifyCustomer, staffNote },
        "orderCancel",
        "orderCancelUserErrors",
      );
    }
  } else if (op === "tagsAdd" || op === "tagsRemove") {
    const tags = String(fd.get("tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) {
      return Response.json(
        { ...empty, message: "Enter at least one tag." },
        { status: 400 },
      );
    }
    if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      return Response.json(
        {
          ...empty,
          message: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }
    const mutation =
      op === "tagsAdd" ? TAGS_ADD_MUTATION : TAGS_REMOVE_MUTATION;
    const rootKey = op === "tagsAdd" ? "tagsAdd" : "tagsRemove";
    for (const id of orderIds) {
      await runOne(id, mutation, { id, tags }, rootKey, "userErrors");
    }
  } else if (op === "markFulfilled") {
    const trackingNumber = String(fd.get("trackingNumber") || "").trim();
    const trackingUrl = String(fd.get("trackingUrl") || "").trim();
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    if (trackingUrl && !isHttpTrackingUrl(trackingUrl)) {
      return Response.json(
        {
          ...empty,
          message: "Tracking URL must start with http:// or https://.",
        },
        { status: 400 },
      );
    }

    for (const id of orderIds) {
      let foJson: {
        data?: {
          order?: {
            fulfillmentOrders?: {
              nodes?: Array<{
                id: string;
                status: string;
                supportedActions?: Array<{ action: string }>;
              }>;
            };
          };
        };
        errors?: Array<{ message: string }>;
      };
      try {
        const foRes = await admin.graphql(GET_ORDER_FULFILLMENT_ORDERS_QUERY, {
          variables: { id },
        });
        foJson = await foRes.json();
      } catch (e: unknown) {
        const m =
          e instanceof Error ? e.message : "Failed to read fulfillment orders";
        results.push({ orderId: id, success: false, message: scopeHint(m) });
        continue;
      }
      if (foJson.errors?.length) {
        const msg = foJson.errors.map((e) => e.message).join("; ");
        results.push({ orderId: id, success: false, message: scopeHint(msg) });
        continue;
      }
      const nodes = foJson.data?.order?.fulfillmentOrders?.nodes || [];
      const fulfillable = nodes.filter((n) =>
        (n.supportedActions || []).some(
          (a) => a.action === "CREATE_FULFILLMENT",
        ),
      );
      if (fulfillable.length === 0) {
        results.push({
          orderId: id,
          success: false,
          message: "No fulfillable items remaining.",
        });
        continue;
      }

      const fulfillment: Record<string, unknown> = {
        lineItemsByFulfillmentOrder: fulfillable.map((fo) => ({
          fulfillmentOrderId: fo.id,
        })),
        notifyCustomer,
      };
      if (trackingNumber || trackingUrl) {
        const trackingInfo: Record<string, string> = {};
        if (trackingNumber) trackingInfo.number = trackingNumber;
        if (trackingUrl) trackingInfo.url = trackingUrl;
        fulfillment.trackingInfo = trackingInfo;
      }

      const before = results.length;
      await runOne(
        id,
        FULFILLMENT_CREATE_MUTATION,
        { fulfillment },
        "fulfillmentCreate",
        "userErrors",
      );
      for (let i = before; i < results.length; i++) {
        const r = results[i];
        if (!r.success && r.message) r.message = scopeHint(r.message);
      }
    }
  } else {
    return Response.json(
      { ...empty, message: "Unknown action." },
      { status: 400 },
    );
  }

  const okCount = results.filter((r) => r.success).length;
  const failedCount = results.length - okCount;
  const payload: BulkActionResponse = {
    ok: failedCount === 0,
    action: op,
    results,
    summary: { ok: okCount, failed: failedCount },
  };
  return Response.json(payload);
};

// ─── Tab types ────────────────────────────────────────────────────────────────

type ActiveTab =
  | "all"
  | "today"
  | "tomorrow"
  | "thisWeek"
  | "unfulfilled"
  | "unpaid";

// ─── StatusBadge (plain HTML — for use inside the drawer div overlay) ─────────

const BADGE_COLORS: Record<BadgeTone, { color: string; bg: string }> = {
  success: { color: "#008060", bg: "#d3f0e0" },
  warning: { color: "#916a00", bg: "#fdf0cc" },
  critical: { color: "#d72c0d", bg: "#ffe9e8" },
  info: { color: "#0065bd", bg: "#e0f0ff" },
  caution: { color: "#916a00", bg: "#fdf0cc" },
  neutral: { color: "#6d7175", bg: "#f0f0f0" },
};

function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const { color, bg } = BADGE_COLORS[tone] ?? BADGE_COLORS.neutral;
  return (
    <span className="ods-badge" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

// ─── OrderDrawer ──────────────────────────────────────────────────────────────

interface OrderDrawerProps {
  order: Order;
  onClose: () => void;
}

function OrderDrawer({ order, onClose }: OrderDrawerProps) {
  const [copySuccess, setCopySuccess] = useState(false);

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const phone = getOrderPhone(order);
  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const todayISO = toLocalISODate(new Date());
  const isOpenOrder = isOpenFulfillmentStatus(order.displayFulfillmentStatus);
  const deliveryRelative =
    rawDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDate, todayISO);
  const timeWindow = getDeliveryTimeValue(order);
  const addr = order.shippingAddress;
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const attrs = order.customAttributes || [];
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  const instruction = getInstructionValue(order);
  const items = order.lineItems?.edges || [];
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const email = order.customer?.defaultEmailAddress?.emailAddress || "—";
  const customerId = order.customer?.id?.split("/").pop();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildDeliveryInfoText(order));
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    } catch {
      // clipboard unavailable — silently skip
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    // Lock body scroll while drawer is open
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div className="ods-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        className="ods-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${order.name} details`}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="ods-drawer-head">
          <div className="ods-drawer-head-row">
            <div>
              <p className="ods-drawer-order-num">{order.name}</p>
              <div className="ods-drawer-badges">
                <StatusBadge
                  tone={financialStatusTone(order.displayFinancialStatus)}
                  label={formatStatusLabel(order.displayFinancialStatus)}
                />
                <StatusBadge
                  tone={fulfillmentStatusTone(order.displayFulfillmentStatus)}
                  label={formatStatusLabel(order.displayFulfillmentStatus)}
                />
              </div>
            </div>
            <button
              className="ods-drawer-close"
              onClick={onClose}
              aria-label="Close order details"
            >
              ×
            </button>
          </div>
          <p className="ods-drawer-customer">{customerName}</p>
          <p className="ods-drawer-total">{total}</p>
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <div className="ods-drawer-body">
          {/* Delivery section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Delivery</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Date</dt>
              <dd className="ods-dd">
                <span className="ods-drawer-delivery-date">
                  <span>{deliveryDate}</span>
                  {deliveryRelative && (
                    <span
                      className={`ods-delivery-relative${deliveryOverdue ? " ods-delivery-relative--overdue" : ""}`}
                    >
                      {deliveryRelative}
                    </span>
                  )}
                </span>
              </dd>
              <dt className="ods-dt">Time window</dt>
              <dd className="ods-dd">{timeWindow}</dd>
              <dt className="ods-dt">Address</dt>
              <dd className="ods-dd">{fullAddress}</dd>
              <dt className="ods-dt">City</dt>
              <dd className="ods-dd">{city}</dd>
              {addr?.province && (
                <>
                  <dt className="ods-dt">Province</dt>
                  <dd className="ods-dd">{addr.province}</dd>
                </>
              )}
              <dt className="ods-dt">Card message</dt>
              <dd className="ods-dd">{cardMessage}</dd>
              <dt className="ods-dt">Instructions</dt>
              <dd className="ods-dd">{instruction}</dd>
            </dl>
            <div className="ods-drawer-actions">
              <button className="ods-action-link" onClick={handleCopy}>
                Copy all delivery info
              </button>
              {copySuccess && <span className="ods-copy-success">Copied.</span>}
            </div>
          </div>

          {/* Customer section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Customer</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Name</dt>
              <dd className="ods-dd">{customerName}</dd>
              <dt className="ods-dt">Email</dt>
              <dd className="ods-dd">{email}</dd>
              <dt className="ods-dt">Phone</dt>
              <dd className="ods-dd">{phone}</dd>
            </dl>
            <div className="ods-drawer-actions">
              {phone !== "—" && (
                <a href={`tel:${phone}`} className="ods-action-link">
                  Call
                </a>
              )}
              {phone !== "—" && (
                <a href={`sms:${phone}`} className="ods-action-link">
                  Text
                </a>
              )}
              {customerId && (
                <a
                  href={`shopify://admin/customers/${customerId}`}
                  className="ods-action-link"
                >
                  View customer
                </a>
              )}
            </div>
          </div>

          {/* Items section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Items ({items.length})</p>
            {items.length === 0 ? (
              <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
                No items.
              </p>
            ) : (
              <div>
                {items.map((edge, idx) => {
                  const item = edge.node;
                  const imgUrl =
                    item.image?.url || item.product?.featuredImage?.url;
                  const imgAlt =
                    item.image?.altText ||
                    item.product?.featuredImage?.altText ||
                    item.name;
                  return (
                    <div key={idx} className="ods-item-row">
                      {imgUrl ? (
                        <img
                          className="ods-item-thumb"
                          src={imgUrl}
                          alt={imgAlt}
                        />
                      ) : (
                        <div className="ods-item-thumb-placeholder" />
                      )}
                      <div className="ods-item-info">
                        <div className="ods-item-name">{item.name}</div>
                        {item.sku && (
                          <div className="ods-item-sku">SKU: {item.sku}</div>
                        )}
                      </div>
                      <div className="ods-item-qty">× {item.quantity}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Admin link */}
          <div className="ods-drawer-section">
            <div className="ods-drawer-actions">
              <a
                href={`shopify://admin/orders/${orderId}`}
                className="ods-action-link"
              >
                Open in Shopify Admin
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Main Extension ───────────────────────────────────────────────────────────

function Extension() {
  const loaderData = useLoaderData() as LoaderData;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const orders = loaderData.orders;
  const pageInfo = loaderData.pageInfo;
  const loading = navigation.state === "loading";
  const deliveryDateFilter = loaderData.deliveryDateParam || "";

  const [error] = useState<string | null>(
    loaderData.errors
      ? loaderData.errors.map((e) => e.message).join(", ")
      : null,
  );
  const [errorDismissed, setErrorDismissed] = useState<boolean>(false);

  // Filter state (client-side only)
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [timeWindowFilter, setTimeWindowFilter] = useState<string>("");

  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>("all");

  // Sort state
  const [sortState, setSortState] = useState<SortState>({
    column: null,
    direction: "asc",
  });

  // Row selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Right-side drawer state
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // Column visibility state
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(DEFAULT_VISIBLE_COLUMNS),
  );

  const handleCloseDrawer = useCallback(() => setSelectedOrder(null), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const handleResize = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setVisibleColumns(new Set(MOBILE_VISIBLE_COLUMNS));
      } else {
        setVisibleColumns(new Set(DEFAULT_VISIBLE_COLUMNS));
      }
    };
    handleResize(mediaQuery); // Run immediately
    mediaQuery.addEventListener("change", handleResize); // Listen for resizes
    return () => mediaQuery.removeEventListener("change", handleResize);
  }, []);

  const subtitleDate = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );

  // Stable date references for tab filtering (computed once per mount)
  const dateRefs = useMemo(() => {
    const now = new Date();
    const todayISO = toLocalISODate(now);
    const tom = new Date(now);
    tom.setDate(now.getDate() + 1);
    const tomorrowISO = toLocalISODate(tom);
    const dow = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      todayISO,
      tomorrowISO,
      startWeekISO: toLocalISODate(monday),
      endWeekISO: toLocalISODate(sunday),
    };
  }, []);

  const handleToggleColumn = (colId: string, checked: boolean) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (checked) next.add(colId);
      else next.delete(colId);
      return next;
    });
  };

  // ── Search handler ─────────────────────────────────────────────────────────

  const handleSearchInput = (e: Event): void => {
    setSearchTerm(getSafeEventValue(e));
  };

  // ── Sort handler ───────────────────────────────────────────────────────────

  const handleSort = useCallback((col: SortableColumn): void => {
    setSortState((prev) => ({
      column: col,
      direction:
        prev.column === col && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  // ── Filter handlers ─────────────────────────────────────────────────────────

  const handleDateChange = (value: string): void => {
    const iso = normalizeDateToISO(value);
    const params = new URLSearchParams(searchParams);
    if (iso) {
      params.set("deliveryDate", iso);
    } else {
      params.delete("deliveryDate");
    }
    setSelectedIds(new Set());
    navigate(`?${params.toString()}`, { replace: true });
  };

  const handleClearFilters = (): void => {
    setSearchTerm("");
    setTimeWindowFilter("");
    setSelectedIds(new Set());
    setActiveTab("all");
    setSortState({ column: null, direction: "asc" });
    navigate("?", { replace: true });
  };

  // ── Row selection handlers ─────────────────────────────────────────────────

  const handleToggleRow = (id: string, checked: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleToggleAll = (checked: boolean): void => {
    if (checked) {
      setSelectedIds(new Set(displayedOrders.map((o) => o.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleClearSelection = (): void => {
    setSelectedIds(new Set());
  };

  // ── Pagination (no-op — server pagination requires useFetcher) ─────────────

  const handleNextPage = (): void => {};
  const handlePreviousPage = (): void => {};

  // ── Client-side filter (existing logic preserved; tab filter added before) ──

  const filteredOrders: Order[] = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const normalizedTimeSlotFilter = normalizeTimeSlot(timeWindowFilter);

    return orders.filter((order) => {
      // ── Tab filter (new) ──────────────────────────────────────────────
      if (activeTab === "today") {
        if (getDeliveryDateValue(order) !== dateRefs.todayISO) return false;
      } else if (activeTab === "tomorrow") {
        if (getDeliveryDateValue(order) !== dateRefs.tomorrowISO) return false;
      } else if (activeTab === "thisWeek") {
        const d = getDeliveryDateValue(order);
        if (d === "—" || d < dateRefs.startWeekISO || d > dateRefs.endWeekISO)
          return false;
      } else if (activeTab === "unfulfilled") {
        if (order.displayFulfillmentStatus?.toUpperCase() !== "UNFULFILLED")
          return false;
      } else if (activeTab === "unpaid") {
        const unpaidSet = new Set(["pending", "authorized", "partially_paid"]);
        if (!unpaidSet.has((order.displayFinancialStatus || "").toLowerCase()))
          return false;
      }

      // ── Existing filter logic (unchanged) ──────────────────────────────
      if (deliveryDateFilter) {
        if (getDeliveryDateValue(order) !== deliveryDateFilter) return false;
      }
      if (normalizedTimeSlotFilter) {
        const orderTime = getDeliveryTimeValue(order);
        if (normalizeTimeSlot(orderTime) !== normalizedTimeSlotFilter)
          return false;
      }
      if (normalizedSearch) {
        if (!getSearchableOrderText(order).includes(normalizedSearch))
          return false;
      }

      return true;
    });
  }, [
    orders,
    deliveryDateFilter,
    timeWindowFilter,
    searchTerm,
    activeTab,
    dateRefs,
  ]);

  const displayedOrders: Order[] = useMemo(() => {
    if (!sortState.column) return filteredOrders;
    return [...filteredOrders].sort((a, b) => {
      let cmp = 0;
      switch (sortState.column) {
        case "timeWindow": {
          const ta = getDeliveryTimeValue(a);
          const tb = getDeliveryTimeValue(b);
          cmp = parseTimeWindowHour(ta) - parseTimeWindowHour(tb);
          break;
        }
        case "deliveryDate": {
          const da = parseDateValue(getDeliveryDateValue(a));
          const db = parseDateValue(getDeliveryDateValue(b));
          cmp = da - db;
          break;
        }
        case "fulfillment": {
          const fa =
            FULFILLMENT_ORDER[a.displayFulfillmentStatus?.toUpperCase()] ?? 99;
          const fb =
            FULFILLMENT_ORDER[b.displayFulfillmentStatus?.toUpperCase()] ?? 99;
          cmp = fa - fb;
          break;
        }
        case "city": {
          const ca = getCity(a).toLowerCase();
          const cb = getCity(b).toLowerCase();
          cmp = ca.localeCompare(cb);
          break;
        }
      }
      return sortState.direction === "asc" ? cmp : -cmp;
    });
  }, [filteredOrders, sortState]);

  // Selection derived values
  const selectedCount: number = selectedIds.size;
  const allSelected: boolean =
    displayedOrders.length > 0 &&
    displayedOrders.every((o) => selectedIds.has(o.id));
  const someSelected: boolean = selectedCount > 0 && !allSelected;

  // ── KPI computations ────────────────────────────────────────────────────────

  const kpiOrderCount: number = displayedOrders.length;

  const { kpiRevenue, kpiAvgRevenue } = useMemo(() => {
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
  }, [displayedOrders]);

  const { kpiUnpaidCount, kpiUnpaidTotal } = useMemo(() => {
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
  }, [displayedOrders]);

  const { kpiUnfulfilledCount, kpiUnfulfilledDueToday } = useMemo(() => {
    const count = displayedOrders.filter(
      (o) => o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
    ).length;
    const dueToday = displayedOrders.filter((o) => {
      if (o.displayFulfillmentStatus?.toUpperCase() !== "UNFULFILLED")
        return false;
      const d = getDeliveryDateValue(o);
      return d !== "—" && d <= dateRefs.todayISO;
    }).length;
    return {
      kpiUnfulfilledCount: count,
      kpiUnfulfilledDueToday: dueToday,
    };
  }, [displayedOrders, dateRefs.todayISO]);

  const { kpiTotalQuantity, kpiProducts } = useMemo(() => {
    if (displayedOrders.length === 0)
      return { kpiTotalQuantity: "—", kpiProducts: [] as [string, number][] };
    let total = 0;
    const productMap = new Map<string, number>();

    for (const o of displayedOrders) {
      if (o.cancelledAt) continue; // F07: cancelled orders do not contribute to products to prepare
      const items = o.lineItems?.edges || [];
      for (const item of items) {
        const qty = item.node.quantity || 0;
        total += qty;
        if (item.node.name) {
          const name = item.node.name;
          productMap.set(name, (productMap.get(name) || 0) + qty);
        }
      }
    }

    const sortedProducts = Array.from(productMap.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    return {
      kpiTotalQuantity: String(total), // F06: always show the real counted total
      kpiProducts: sortedProducts,
    };
  }, [displayedOrders]);

  // ── Tab counts (for badge pills) ──────────────────────────────────────────

  const tabCounts = useMemo(() => {
    return {
      today: orders.filter((o) => getDeliveryDateValue(o) === dateRefs.todayISO)
        .length,
      tomorrow: orders.filter(
        (o) => getDeliveryDateValue(o) === dateRefs.tomorrowISO,
      ).length,
      thisWeek: orders.filter((o) => {
        const d = getDeliveryDateValue(o);
        return (
          d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
        );
      }).length,
      unfulfilled: orders.filter(
        (o) => o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
      ).length,
      unpaid: orders.filter((o) => isUnpaidStatus(o.displayFinancialStatus))
        .length,
    };
  }, [orders, dateRefs]);

  // ── Export for Lalamove ──────────────────────────────────────────────────────

  const exportForLalamove = (): void => {
    const selectedOrders = displayedOrders.filter((o) => selectedIds.has(o.id));
    const headers = [
      '"1. Address"',
      '"2. Name"',
      '"3. Phone"',
      '"4. Block/floor"',
    ];
    const rows = selectedOrders.map((order) => {
      const addr = order.shippingAddress;
      const address = addr?.address1 || "";
      const name = getCustomerName(order);
      const phone = getOrderPhone(order);
      const blockFloor = [addr?.address2, addr?.city]
        .filter(Boolean)
        .join(", ");
      return [
        `"${address.replace(/"/g, '""')}"`,
        `"${name.replace(/"/g, '""')}"`,
        `"${phone.replace(/"/g, '""')}"`,
        `"${blockFloor.replace(/"/g, '""')}"`,
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const today = toLocalISODate(new Date());
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lalamove-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Bulk actions (archive / unarchive / cancel / tags) ─────────────────────

  const fetcher = useFetcher<BulkActionResponse>();
  const isSubmitting: boolean = fetcher.state !== "idle";

  const [actionBanner, setActionBanner] = useState<{
    tone: "success" | "critical" | "warning";
    heading: string;
    body?: string;
  } | null>(null);

  // Cancel modal form state
  const [cancelReason, setCancelReason] = useState<string>("CUSTOMER");
  const [cancelRestock, setCancelRestock] = useState<boolean>(false);
  const [cancelNotify, setCancelNotify] = useState<boolean>(false);
  const [cancelStaffNote, setCancelStaffNote] = useState<string>("");

  // Tag modal form state
  const [addTagsInput, setAddTagsInput] = useState<string>("");
  const [removeTagsInput, setRemoveTagsInput] = useState<string>("");

  // Mark as fulfilled modal form state
  const [fulfillTrackingNumber, setFulfillTrackingNumber] =
    useState<string>("");
  const [fulfillTrackingUrl, setFulfillTrackingUrl] = useState<string>("");
  const [fulfillNotify, setFulfillNotify] = useState<boolean>(false);

  const hideModal = (id: string) => {
    const el = document.getElementById(id) as
      | (HTMLElement & { hide?: () => void })
      | null;
    if (!el) return;
    if (typeof el.hide === "function") el.hide();
    else el.removeAttribute("open");
  };

  const submitBulk = useCallback(
    (op: BulkActionName, extras?: Record<string, string>) => {
      if (selectedIds.size === 0) return;
      const fd = new FormData();
      fd.append("_action", op);
      selectedIds.forEach((id) => fd.append("orderId", id));
      if (extras) {
        for (const [k, v] of Object.entries(extras)) fd.append(k, v);
      }
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher, selectedIds],
  );

  const handleArchive = () => submitBulk("archive");
  const handleUnarchive = () => submitBulk("unarchive");

  const handleCancelConfirm = () => {
    submitBulk("cancel", {
      reason: cancelReason,
      restock: cancelRestock ? "1" : "0",
      notifyCustomer: cancelNotify ? "1" : "0",
      staffNote: cancelStaffNote,
    });
  };

  const handleAddTags = () => {
    if (!addTagsInput.trim()) return;
    submitBulk("tagsAdd", { tags: addTagsInput });
  };

  const handleRemoveTags = () => {
    if (!removeTagsInput.trim()) return;
    submitBulk("tagsRemove", { tags: removeTagsInput });
  };

  const handleMarkFulfilled = () => {
    submitBulk("markFulfilled", {
      trackingNumber: fulfillTrackingNumber,
      trackingUrl: fulfillTrackingUrl,
      notifyCustomer: fulfillNotify ? "1" : "0",
    });
  };

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    const d = fetcher.data;
    const actionLabel: Record<BulkActionName, { verb: string; ing: string }> = {
      archive: { verb: "archived", ing: "Archive" },
      unarchive: { verb: "unarchived", ing: "Unarchive" },
      cancel: { verb: "queued for cancellation", ing: "Cancel" },
      tagsAdd: { verb: "updated (tags added)", ing: "Add tags" },
      tagsRemove: { verb: "updated (tags removed)", ing: "Remove tags" },
      markFulfilled: { verb: "marked as fulfilled", ing: "Mark as fulfilled" },
    };
    const meta = d.action ? actionLabel[d.action] : null;

    if (d.ok && d.summary && d.summary.ok > 0) {
      const n = d.summary.ok;
      setActionBanner({
        tone: "success",
        heading: `${n} ${n === 1 ? "order" : "orders"} ${meta?.verb ?? "updated"}.`,
      });
      setSelectedIds(new Set());
      hideModal("modal-cancel-orders");
      hideModal("modal-add-tags");
      hideModal("modal-remove-tags");
      hideModal("modal-mark-fulfilled");
      setCancelStaffNote("");
      setAddTagsInput("");
      setRemoveTagsInput("");
      setFulfillTrackingNumber("");
      setFulfillTrackingUrl("");
      setFulfillNotify(false);
    } else if (d.summary && d.summary.failed > 0) {
      const failed = (d.results || []).filter((r) => !r.success);
      const lines = failed
        .slice(0, 3)
        .map((r) => `${r.orderId.split("/").pop()}: ${r.message ?? "Failed"}`)
        .join(" • ");
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
      const okN = d.summary.ok;
      const failN = d.summary.failed;
      setActionBanner({
        tone: okN > 0 ? "warning" : "critical",
        heading:
          okN > 0
            ? `${okN} succeeded, ${failN} failed`
            : `${meta?.ing ?? "Action"} failed for ${failN} ${failN === 1 ? "order" : "orders"}.`,
        body: lines + more,
      });
    } else if (d.message) {
      setActionBanner({ tone: "critical", heading: d.message });
    }
  }, [fetcher.data, fetcher.state]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const sortLabel: string = sortState.column
    ? `${sortState.column === "timeWindow" ? "Time window" : sortState.column === "deliveryDate" ? "Delivery date" : sortState.column === "fulfillment" ? "Fulfillment" : "City"} ${
        sortState.direction === "asc" ? "↑" : "↓"
      }`
    : "Sort";

  const tabDefs: { id: ActiveTab; label: string; count: number }[] = [
    { id: "all", label: "All", count: orders.length },
    { id: "today", label: "Today", count: tabCounts.today },
    { id: "tomorrow", label: "Tomorrow", count: tabCounts.tomorrow },
    { id: "thisWeek", label: "This week", count: tabCounts.thisWeek },
    { id: "unfulfilled", label: "Unfulfilled", count: tabCounts.unfulfilled },
    { id: "unpaid", label: "Unpaid", count: tabCounts.unpaid },
  ];

  const hasActiveFilters = Boolean(
    searchTerm.trim() ||
    timeWindowFilter ||
    deliveryDateFilter ||
    activeTab !== "all",
  );
  const hasActiveViewControls = Boolean(hasActiveFilters || sortState.column);

  return (
    <s-page
      id="orders-dashboard-page"
      heading="Orders Operations"
      inlineSize="large"
    >
      {/* ── Global modals ──────────────────────────────────────────────────── */}

      {/* Sort menu */}
      <s-menu id="sort-menu" accessibilityLabel="Sort orders">
        <s-button
          icon={
            sortState.column === "deliveryDate"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("deliveryDate")}
        >
          Delivery date
          {sortState.column === "deliveryDate"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "timeWindow"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("timeWindow")}
        >
          Time window
          {sortState.column === "timeWindow"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "fulfillment"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("fulfillment")}
        >
          Fulfillment
          {sortState.column === "fulfillment"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "city"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("city")}
        >
          City
          {sortState.column === "city"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
      </s-menu>

      {/* Columns config modal */}
      <s-modal
        id="modal-columns"
        heading="Configure Table Columns"
        size="large"
      >
        <s-box padding="base">
          <s-stack direction="inline" gap="large">
            <s-stack direction="block" gap="small">
              <s-text type="strong">General</s-text>
              <s-checkbox
                label="Order name"
                checked={visibleColumns.has("name")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "name",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Actions"
                checked={visibleColumns.has("actions")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "actions",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Customer</s-text>
              <s-checkbox
                label="Customer"
                checked={visibleColumns.has("customer")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "customer",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="City"
                checked={visibleColumns.has("city")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "city",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Status</s-text>
              <s-checkbox
                label="Payment status"
                checked={visibleColumns.has("payment")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "payment",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Fulfillment status"
                checked={visibleColumns.has("fulfillment")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "fulfillment",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Details</s-text>
              <s-checkbox
                label="Items"
                checked={visibleColumns.has("items")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "items",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Delivery date"
                checked={visibleColumns.has("deliveryDate")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "deliveryDate",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Time window"
                checked={visibleColumns.has("timeWindow")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "timeWindow",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Total"
                checked={visibleColumns.has("total")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "total",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Tags / Attributes"
                checked={visibleColumns.has("tags")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "tags",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          commandFor="modal-columns"
          command="--hide"
        >
          Done
        </s-button>
      </s-modal>

      {/* Bulk actions menu */}
      <s-menu id="bulk-actions-menu" accessibilityLabel="Bulk actions">
        <s-button onClick={handleArchive} disabled={isSubmitting}>
          Archive orders
        </s-button>
        <s-button onClick={handleUnarchive} disabled={isSubmitting}>
          Unarchive orders
        </s-button>
        <s-button
          commandFor="modal-add-tags"
          command="--show"
          disabled={isSubmitting}
        >
          Add tags…
        </s-button>
        <s-button
          commandFor="modal-remove-tags"
          command="--show"
          disabled={isSubmitting}
        >
          Remove tags…
        </s-button>
        <s-button
          commandFor="modal-mark-fulfilled"
          command="--show"
          disabled={isSubmitting}
        >
          Mark as fulfilled…
        </s-button>
        <s-button
          commandFor="modal-cancel-orders"
          command="--show"
          tone="critical"
          disabled={isSubmitting}
        >
          Cancel orders…
        </s-button>
      </s-menu>

      {/* Cancel orders confirmation modal */}
      <s-modal
        id="modal-cancel-orders"
        heading="Cancel selected orders?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="critical">
              <s-paragraph>
                {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
                be cancelled. Cancellation is irreversible.
              </s-paragraph>
            </s-banner>
            <s-select
              id="cancel-reason"
              label="Cancellation reason"
              value={cancelReason}
              onChange={(e: Event) => setCancelReason(getSafeEventValue(e))}
            >
              <s-option value="CUSTOMER">Customer request</s-option>
              <s-option value="INVENTORY">Insufficient inventory</s-option>
              <s-option value="DECLINED">Payment declined</s-option>
              <s-option value="FRAUD">Fraud</s-option>
              <s-option value="STAFF">Staff error</s-option>
              <s-option value="OTHER">Other</s-option>
            </s-select>
            <s-checkbox
              label="Restock inventory committed to these orders"
              checked={cancelRestock}
              onChange={(e: Event) =>
                setCancelRestock((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <s-checkbox
              label="Notify customers by email"
              checked={cancelNotify}
              onChange={(e: Event) =>
                setCancelNotify((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <s-text-field
              id="cancel-staff-note"
              label="Staff note (optional, internal only — max 255 chars)"
              value={cancelStaffNote}
              onInput={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
              onChange={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-cancel-orders"
          command="--hide"
          disabled={isSubmitting}
        >
          Keep them
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleCancelConfirm}
        >
          {isSubmitting
            ? "Cancelling…"
            : `Cancel ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
        </s-button>
      </s-modal>

      {/* Mark as fulfilled modal */}
      <s-modal
        id="modal-mark-fulfilled"
        heading="Mark selected orders as fulfilled?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>
                This creates a real Shopify fulfillment for {selectedCount}{" "}
                {selectedCount === 1 ? "order" : "orders"}. Customers will
                receive a notification email if &quot;Notify customer&quot; is
                enabled.
              </s-paragraph>
            </s-banner>
            <s-text-field
              id="fulfill-tracking-number"
              label="Tracking number (optional)"
              placeholder="e.g. 1Z999AA10123456784"
              value={fulfillTrackingNumber}
              onInput={(e: Event) =>
                setFulfillTrackingNumber(getSafeEventValue(e))
              }
              onChange={(e: Event) =>
                setFulfillTrackingNumber(getSafeEventValue(e))
              }
            />
            <s-text-field
              id="fulfill-tracking-url"
              label="Tracking URL (optional)"
              placeholder="https://tracking.example.com/…"
              value={fulfillTrackingUrl}
              onInput={(e: Event) =>
                setFulfillTrackingUrl(getSafeEventValue(e))
              }
              onChange={(e: Event) =>
                setFulfillTrackingUrl(getSafeEventValue(e))
              }
            />
            <s-checkbox
              label="Notify customer by email"
              checked={fulfillNotify}
              onChange={(e: Event) =>
                setFulfillNotify((e.currentTarget as HTMLInputElement).checked)
              }
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-mark-fulfilled"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleMarkFulfilled}
        >
          {isSubmitting
            ? "Fulfilling…"
            : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} fulfilled`}
        </s-button>
      </s-modal>

      {/* Add tags modal */}
      <s-modal
        id="modal-add-tags"
        heading="Add tags to selected orders"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-text>
              Add the tags below to {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}.
            </s-text>
            <s-text-field
              id="add-tags-input"
              label="Tags (comma-separated)"
              placeholder="e.g. priority, vip, mothers-day"
              value={addTagsInput}
              onInput={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
              onChange={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-add-tags"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || !addTagsInput.trim() || selectedCount === 0}
          onClick={handleAddTags}
        >
          {isSubmitting ? "Adding…" : "Add tags"}
        </s-button>
      </s-modal>

      {/* Remove tags modal */}
      <s-modal
        id="modal-remove-tags"
        heading="Remove tags from selected orders"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-text>
              Remove the tags below from {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}.
            </s-text>
            <s-text-field
              id="remove-tags-input"
              label="Tags (comma-separated)"
              placeholder="e.g. priority, vip"
              value={removeTagsInput}
              onInput={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
              onChange={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-remove-tags"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={
            isSubmitting || !removeTagsInput.trim() || selectedCount === 0
          }
          onClick={handleRemoveTags}
        >
          {isSubmitting ? "Removing…" : "Remove tags"}
        </s-button>
      </s-modal>

      {/* Items to prep modal (triggered by KPI card button) */}
      <s-modal id="modal-kpi-products" heading="Items to prepare" size="small">
        <s-box padding="base">
          <s-stack direction="block" gap="small">
            {kpiProducts.length === 0 ? (
              <s-text color="subdued">No products found.</s-text>
            ) : (
              <s-stack direction="block" gap="small-100">
                {kpiProducts.map(([name, qty], idx) => (
                  <s-stack
                    key={idx}
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-text>{name}</s-text>
                    <s-text type="strong">× {qty}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          commandFor="modal-kpi-products"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      {/* ── Error banner ────────────────────────────────────────────────────── */}
      {error && !errorDismissed && (
        <s-banner
          id="error-banner"
          tone="critical"
          heading="Failed to load orders"
          dismissible
          onDismiss={() => setErrorDismissed(true)}
        >
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {/* ── Bulk action result banner ───────────────────────────────────────── */}
      {actionBanner && (
        <s-banner
          id="bulk-action-banner"
          tone={actionBanner.tone}
          heading={actionBanner.heading}
          dismissible
          onDismiss={() => setActionBanner(null)}
        >
          {actionBanner.body && <s-paragraph>{actionBanner.body}</s-paragraph>}
        </s-banner>
      )}

      {/* ── Header actions bar ───────────────────────────────────────────────── */}
      <div className="ods-header-bar">
        <p className="ods-subtitle">
          Plan, prep, and dispatch deliveries for {subtitleDate}.
        </p>
        <div className="ods-header-btns">
          <s-button
            variant="secondary"
            icon="print"
            onClick={() => window.print()}
          >
            Print picklist
          </s-button>
          <s-button
            variant="secondary"
            icon="export"
            onClick={exportForLalamove}
          >
            Export
          </s-button>
          <s-button variant="primary" href="shopify://admin/orders/new">
            Create order
          </s-button>
        </div>
      </div>

      {/* ── KPI grid ─────────────────────────────────────────────────────────── */}
      <div className="ods-kpi-grid">
        <div
          className="ods-kpi-card ods-kpi-card--clickable"
          onClick={() => setActiveTab("all")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && setActiveTab("all")
          }
        >
          <p className="ods-kpi-label">Orders</p>
          <p className="ods-kpi-value" aria-live="polite">
            {kpiOrderCount}
          </p>
          {tabCounts.today > 0 && (
            <p className="ods-kpi-sublabel">
              • {tabCounts.today} delivering today
            </p>
          )}
        </div>
        <div className="ods-kpi-card">
          <p className="ods-kpi-label">Revenue</p>
          <p className="ods-kpi-value" aria-live="polite">
            {kpiRevenue}
          </p>
          {kpiAvgRevenue && (
            <p className="ods-kpi-sublabel">• {kpiAvgRevenue}</p>
          )}
        </div>
        <div
          className="ods-kpi-card ods-kpi-card--clickable"
          onClick={() => setActiveTab("unpaid")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && setActiveTab("unpaid")
          }
        >
          <p className="ods-kpi-label">Unpaid</p>
          <p
            className={`ods-kpi-value${kpiUnpaidCount > 0 ? " ods-kpi-value--danger" : ""}`}
            aria-live="polite"
          >
            {kpiUnpaidCount}
          </p>
          {kpiUnpaidTotal && (
            <p
              className={`ods-kpi-sublabel${kpiUnpaidCount > 0 ? " ods-kpi-sublabel--danger" : ""}`}
            >
              {kpiUnpaidTotal}
            </p>
          )}
        </div>
        <div
          className="ods-kpi-card ods-kpi-card--clickable"
          onClick={() => setActiveTab("unfulfilled")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && setActiveTab("unfulfilled")
          }
        >
          <p className="ods-kpi-label">Unfulfilled</p>
          <p
            className={`ods-kpi-value${kpiUnfulfilledCount > 0 ? " ods-kpi-value--danger" : ""}`}
            aria-live="polite"
          >
            {kpiUnfulfilledCount}
          </p>
          {kpiUnfulfilledDueToday > 0 && (
            <p className="ods-kpi-sublabel ods-kpi-sublabel--danger">
              {kpiUnfulfilledDueToday} due today or earlier
            </p>
          )}
        </div>
        <div className="ods-kpi-card">
          <p className="ods-kpi-label">Items to prep</p>
          <s-button
            variant="tertiary"
            commandFor="modal-kpi-products"
            command="--show"
            aria-live="polite"
          >
            <span className="ods-kpi-value ods-kpi-value--link">
              {kpiTotalQuantity}
            </span>
          </s-button>
          <p className="ods-kpi-sublabel">See breakdown →</p>
        </div>
      </div>

      {/* ── Tabs + Table (single child so s-page adds no gap between them) ──── */}
      <div className="ods-tabs-table">
        <div className="ods-tabs" role="tablist" aria-label="Filter orders">
          {tabDefs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`ods-tab${activeTab === tab.id ? " ods-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ods-tab-count">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Table section ────────────────────────────────────────────────────── */}
        <s-section id="orders-table-section" padding="none">
          {selectedCount > 0 && (
            <div
              id="selection-bar"
              className="ods-selection-bar"
              aria-busy={isSubmitting}
            >
              <span className="ods-selection-count">
                {selectedCount} selected
              </span>
              <s-button
                variant="secondary"
                icon="menu-horizontal"
                commandFor="bulk-actions-menu"
                disabled={isSubmitting}
                accessibilityLabel="Bulk actions"
              >
                {isSubmitting ? "Working…" : "Bulk actions"}
              </s-button>
              <s-button
                variant="secondary"
                onClick={exportForLalamove}
                disabled={isSubmitting}
              >
                Export for Lalamove
              </s-button>
              <s-button
                variant="tertiary"
                onClick={handleClearSelection}
                disabled={isSubmitting}
              >
                Clear selection
              </s-button>
              {isSubmitting && (
                <span className="ods-selection-status" aria-live="polite">
                  Submitting selected orders...
                </span>
              )}
            </div>
          )}

          <div className="ods-table-frame">
            <s-table
              id="orders-table"
              paginate={true}
              loading={loading}
              hasNextPage={pageInfo?.hasNextPage || false}
              hasPreviousPage={pageInfo?.hasPreviousPage || false}
              onNextPage={handleNextPage}
              onPreviousPage={handlePreviousPage}
            >
              {/* Toolbar — single compact row */}
              <div slot="filters" className="ods-toolbar">
                <div className="ods-toolbar-search">
                  <s-search-field
                    id="search-field"
                    label="Search orders"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search by order, customer, phone, city"
                    value={searchTerm}
                    onInput={handleSearchInput}
                    onChange={handleSearchInput}
                  />
                </div>
                <div className="ods-toolbar-date">
                  <s-date-field
                    id="toolbar-delivery-date-filter"
                    label="Delivery date"
                    labelAccessibilityVisibility="exclusive"
                    value={deliveryDateFilter}
                    onInput={(e: Event) =>
                      handleDateChange(getSafeEventValue(e))
                    }
                    onChange={(e: Event) =>
                      handleDateChange(getSafeEventValue(e))
                    }
                  />
                </div>
                <div className="ods-toolbar-slot">
                  <s-select
                    id="toolbar-time-slot-filter"
                    label="Time slot"
                    labelAccessibilityVisibility="exclusive"
                    value={timeWindowFilter}
                    onChange={(e: Event) => {
                      setTimeWindowFilter(getSafeEventValue(e));
                      setSelectedIds(new Set());
                    }}
                  >
                    <s-option value="">All time slots</s-option>
                    <s-option value="9AM-12PM">9AM-12PM</s-option>
                    <s-option value="12PM-3PM">12PM-3PM</s-option>
                    <s-option value="3PM-6PM">3PM-6PM</s-option>
                    <s-option value="6PM-11PM">6PM-11PM</s-option>
                    <s-option value="8:00 AM - 1:00 PM">
                      8:00 AM - 1:00 PM
                    </s-option>
                    <s-option value="1:00 PM - 7:00 PM">
                      1:00 PM - 7:00 PM
                    </s-option>
                  </s-select>
                </div>
                <div className="ods-toolbar-actions">
                  <s-button
                    variant={hasActiveViewControls ? "secondary" : "tertiary"}
                    onClick={handleClearFilters}
                    disabled={!hasActiveViewControls}
                  >
                    Reset
                  </s-button>
                  <s-button
                    variant="secondary"
                    icon={sortState.column ? "sort-ascending" : "sort"}
                    commandFor="sort-menu"
                    accessibilityLabel="Sort orders"
                  >
                    {sortLabel}
                  </s-button>
                  <s-button
                    variant="secondary"
                    commandFor="modal-columns"
                    accessibilityLabel="Configure columns"
                  >
                    Columns
                  </s-button>
                </div>
              </div>

              {/* Table header */}
              <s-table-header-row id="orders-header-row">
                <s-table-header id="header-select" listSlot="kicker">
                  <s-checkbox
                    id="checkbox-select-all"
                    accessibilityLabel="Select all orders"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(e: Event) =>
                      handleToggleAll(
                        (e.currentTarget as HTMLInputElement).checked,
                      )
                    }
                  />
                </s-table-header>
                {visibleColumns.has("name") && (
                  <s-table-header id="header-order" listSlot="primary">
                    Order
                  </s-table-header>
                )}
                {visibleColumns.has("items") && (
                  <s-table-header id="header-item" listSlot="labeled">
                    Items
                  </s-table-header>
                )}
                {visibleColumns.has("customer") && (
                  <s-table-header id="header-customer" listSlot="secondary">
                    Customer
                  </s-table-header>
                )}
                {visibleColumns.has("city") && (
                  <SortableHeader
                    id="header-city"
                    column="city"
                    label="City"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("deliveryDate") && (
                  <SortableHeader
                    id="header-delivery-date"
                    column="deliveryDate"
                    label="Delivery date"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("timeWindow") && (
                  <SortableHeader
                    id="header-time-window"
                    column="timeWindow"
                    label="Time window"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("payment") && (
                  <s-table-header id="header-payment" listSlot="labeled">
                    Payment
                  </s-table-header>
                )}
                {visibleColumns.has("fulfillment") && (
                  <SortableHeader
                    id="header-fulfillment"
                    column="fulfillment"
                    label="Fulfillment"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("total") && (
                  <s-table-header id="header-total" listSlot="labeled">
                    Total
                  </s-table-header>
                )}
                {visibleColumns.has("actions") && (
                  <s-table-header id="header-actions" listSlot="labeled">
                    Actions
                  </s-table-header>
                )}
                {visibleColumns.has("tags") && (
                  <s-table-header id="header-tags" listSlot="labeled">
                    Tags
                  </s-table-header>
                )}
              </s-table-header-row>

              {/* Table body */}
              <s-table-body id="orders-table-body">
                {!loading && displayedOrders.length === 0 ? (
                  <s-table-row id="empty-row">
                    <s-table-cell id="empty-cell">
                      <s-stack gap="small" alignItems="center">
                        <s-text type="strong">
                          {hasActiveFilters
                            ? "No orders match this view"
                            : "No orders found"}
                        </s-text>
                        <s-text color="subdued">
                          {hasActiveFilters
                            ? "A search, tab, delivery date, or time slot filter may be active. Use Reset to see all loaded orders."
                            : "Orders will appear here after Shopify returns them."}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  displayedOrders.map((order) => {
                    const orderId = order.id.split("/").pop() || order.id;
                    const isChecked: boolean = selectedIds.has(order.id);
                    const customerName =
                      getCustomerName(order) === "—"
                        ? "Guest"
                        : getCustomerName(order);
                    const instructionText = getInstructionValue(order);
                    const rawDeliveryDate = getDeliveryDateValue(order);
                    const deliveryDateDisplay =
                      rawDeliveryDate !== "—"
                        ? formatDeliveryDate(rawDeliveryDate)
                        : "—";
                    const timeWindow = getDeliveryTimeValue(order);
                    const isOpenOrder = isOpenFulfillmentStatus(
                      order.displayFulfillmentStatus,
                    );
                    const deliveryRelative =
                      rawDeliveryDate !== "—" && isOpenOrder
                        ? getDeliveryRelativeLabel(
                            rawDeliveryDate,
                            dateRefs.todayISO,
                          )
                        : "";
                    const deliveryOverdue =
                      rawDeliveryDate !== "—" &&
                      isOpenOrder &&
                      isDeliveryOverdue(rawDeliveryDate, dateRefs.todayISO);
                    const paymentNeedsAttention = isUnpaidStatus(
                      order.displayFinancialStatus,
                    );
                    const fulfillmentNeedsAttention = isOpenOrder;
                    const total = order.currentTotalPriceSet
                      ? formatMoney(
                          order.currentTotalPriceSet.shopMoney.amount,
                          order.currentTotalPriceSet.shopMoney.currencyCode,
                        )
                      : "—";

                    return (
                      <s-table-row id={`order-row-${orderId}`} key={order.id}>
                        {/* Checkbox */}
                        <s-table-cell id={`cell-select-${orderId}`}>
                          <s-checkbox
                            id={`checkbox-row-${orderId}`}
                            accessibilityLabel={`Select order ${order.name}`}
                            checked={isChecked}
                            onChange={(e: Event) =>
                              handleToggleRow(
                                order.id,
                                (e.currentTarget as HTMLInputElement).checked,
                              )
                            }
                          />
                        </s-table-cell>

                        {/* Order name — opens drawer */}
                        {visibleColumns.has("name") && (
                          <s-table-cell id={`cell-name-${orderId}`}>
                            <span className="ods-name-cell">
                              <s-button
                                id={`btn-name-${orderId}`}
                                variant="tertiary"
                                onClick={() => setSelectedOrder(order)}
                                accessibilityLabel={`View order ${order.name} details`}
                              >
                                <s-text type="strong">{order.name}</s-text>
                              </s-button>
                              {instructionText !== "—" && (
                                <span
                                  className="ods-note-icon"
                                  title={instructionText}
                                  aria-label={`Note: ${instructionText}`}
                                  role="img"
                                >
                                  <svg
                                    width="13"
                                    height="13"
                                    viewBox="0 0 14 14"
                                    fill="none"
                                    aria-hidden="true"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <rect
                                      x="1"
                                      y="1"
                                      width="12"
                                      height="12"
                                      rx="2"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="4.5"
                                      x2="10.5"
                                      y2="4.5"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="7"
                                      x2="10.5"
                                      y2="7"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="9.5"
                                      x2="7.5"
                                      y2="9.5"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                </span>
                              )}
                            </span>
                          </s-table-cell>
                        )}

                        {/* Items — thumbnail + summary */}
                        {visibleColumns.has("items") && (
                          <s-table-cell id={`cell-item-${orderId}`}>
                            {(() => {
                              const items = order.lineItems?.edges || [];
                              const itemCount = items.length;
                              const totalQty = items.reduce(
                                (sum, item) => sum + (item.node.quantity || 0),
                                0,
                              );
                              const hasMore = itemCount >= 10;
                              const displayText =
                                itemCount === 0
                                  ? "—"
                                  : itemCount === 1
                                    ? `×${totalQty}`
                                    : hasMore
                                      ? "10+ items"
                                      : `${itemCount} items`;
                              return (
                                <s-button
                                  variant="tertiary"
                                  id={`btn-item-${orderId}`}
                                  onClick={() => setSelectedOrder(order)}
                                >
                                  <s-stack
                                    direction="inline"
                                    gap="small"
                                    alignItems="center"
                                  >
                                    <s-thumbnail
                                      id={`thumbnail-item-${orderId}`}
                                      src={getFirstItemImageUrl(order)}
                                      alt={getFirstItemAltText(order)}
                                      size="small-200"
                                    />
                                    <s-text>{displayText}</s-text>
                                  </s-stack>
                                </s-button>
                              );
                            })()}
                          </s-table-cell>
                        )}

                        {/* Customer */}
                        {visibleColumns.has("customer") && (
                          <s-table-cell id={`cell-customer-${orderId}`}>
                            <s-button
                              variant="tertiary"
                              id={`btn-customer-${orderId}`}
                              onClick={() => setSelectedOrder(order)}
                            >
                              <span className="ods-customer-cell">
                                <span className="ods-customer-name">
                                  {customerName}
                                </span>
                                {order.customer?.defaultEmailAddress
                                  ?.emailAddress && (
                                  <span className="ods-customer-email">
                                    {
                                      order.customer.defaultEmailAddress
                                        .emailAddress
                                    }
                                  </span>
                                )}
                              </span>
                            </s-button>
                          </s-table-cell>
                        )}

                        {/* City */}
                        {visibleColumns.has("city") && (
                          <s-table-cell id={`cell-city-${orderId}`}>
                            <s-text>{getCity(order)}</s-text>
                          </s-table-cell>
                        )}

                        {/* Delivery date */}
                        {visibleColumns.has("deliveryDate") && (
                          <s-table-cell id={`cell-delivery-${orderId}`}>
                            <span className="ods-delivery-cell">
                              <span
                                className={`ods-delivery-date-main${rawDeliveryDate === "—" ? " ods-muted" : ""}`}
                              >
                                {deliveryDateDisplay}
                              </span>
                              {deliveryRelative && (
                                <span
                                  className={`ods-delivery-relative${deliveryOverdue ? " ods-delivery-relative--overdue" : ""}`}
                                >
                                  {deliveryRelative}
                                </span>
                              )}
                            </span>
                          </s-table-cell>
                        )}

                        {/* Time window */}
                        {visibleColumns.has("timeWindow") && (
                          <s-table-cell id={`cell-time-window-${orderId}`}>
                            <span
                              className={`ods-time-window${timeWindow === "—" ? " ods-muted" : ""}`}
                            >
                              {timeWindow}
                            </span>
                          </s-table-cell>
                        )}

                        {/* Payment */}
                        {visibleColumns.has("payment") && (
                          <s-table-cell id={`cell-payment-${orderId}`}>
                            <span
                              className={`ods-status-cell${paymentNeedsAttention ? " ods-status-cell--attention" : ""}`}
                            >
                              <s-badge
                                tone={financialStatusTone(
                                  order.displayFinancialStatus,
                                )}
                              >
                                {formatStatusLabel(
                                  order.displayFinancialStatus,
                                )}
                              </s-badge>
                            </span>
                          </s-table-cell>
                        )}

                        {/* Fulfillment */}
                        {visibleColumns.has("fulfillment") && (
                          <s-table-cell id={`cell-fulfillment-${orderId}`}>
                            <span
                              className={`ods-status-cell${fulfillmentNeedsAttention ? " ods-status-cell--attention" : ""}`}
                            >
                              <s-badge
                                tone={fulfillmentStatusTone(
                                  order.displayFulfillmentStatus,
                                )}
                              >
                                {formatStatusLabel(
                                  order.displayFulfillmentStatus,
                                )}
                              </s-badge>
                            </span>
                          </s-table-cell>
                        )}

                        {/* Total */}
                        {visibleColumns.has("total") && (
                          <s-table-cell id={`cell-total-${orderId}`}>
                            <s-text>{total}</s-text>
                          </s-table-cell>
                        )}

                        {/* Actions — opens drawer */}
                        {visibleColumns.has("actions") && (
                          <s-table-cell id={`cell-action-${orderId}`}>
                            <s-button
                              id={`btn-view-${orderId}`}
                              variant="tertiary"
                              icon="view"
                              onClick={() => setSelectedOrder(order)}
                              accessibilityLabel={`View details for order ${order.name}`}
                            />
                          </s-table-cell>
                        )}

                        {/* Tags */}
                        {visibleColumns.has("tags") && (
                          <s-table-cell id={`cell-tags-${orderId}`}>
                            {(() => {
                              const meaningful = getMeaningfulTags(
                                order.tags || [],
                              );
                              if (meaningful.length === 0) {
                                return <s-text color="subdued">—</s-text>;
                              }
                              const attrCount = meaningful.length;
                              return (
                                <>
                                  <s-button
                                    variant="tertiary"
                                    id={`btn-tags-${orderId}`}
                                    commandFor={`modal-tags-${orderId}`}
                                    command="--show"
                                  >
                                    {attrCount}{" "}
                                    {attrCount === 1
                                      ? "attribute"
                                      : "attributes"}
                                  </s-button>
                                  <s-modal
                                    id={`modal-tags-${orderId}`}
                                    heading="Attributes"
                                    size="small"
                                  >
                                    <s-box padding="base">
                                      <s-stack direction="inline" gap="small">
                                        {meaningful.map((tag) => (
                                          <s-chip
                                            id={`tag-${orderId}-${tag}`}
                                            key={tag}
                                          >
                                            {tagDisplayLabel(tag)}
                                          </s-chip>
                                        ))}
                                      </s-stack>
                                    </s-box>
                                    <s-button
                                      slot="primary-action"
                                      commandFor={`modal-tags-${orderId}`}
                                      command="--hide"
                                    >
                                      Close
                                    </s-button>
                                  </s-modal>
                                </>
                              );
                            })()}
                          </s-table-cell>
                        )}
                      </s-table-row>
                    );
                  })
                )}
              </s-table-body>
            </s-table>
          </div>
        </s-section>
      </div>
      {/* end ods-tabs-table */}

      {/* ── Right-side order detail drawer ──────────────────────────────────── */}
      {selectedOrder && (
        <OrderDrawer order={selectedOrder} onClose={handleCloseDrawer} />
      )}
    </s-page>
  );
}

export default Extension;
