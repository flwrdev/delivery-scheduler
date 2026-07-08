// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmailAddress {
  emailAddress: string;
}

export interface PhoneNumber {
  phoneNumber: string;
}

export interface Customer {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: EmailAddress | null;
  defaultPhoneNumber: PhoneNumber | null;
  numberOfOrders?: number | null;
}

export interface Metafield {
  value: string;
  jsonValue?: unknown;
}

export interface ShippingAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
}

export interface BillingAddress {
  name: string | null;
  address1: string | null;
  phone: string | null;
}

export interface CustomAttribute {
  key: string;
  value: string | null;
}

export interface LineItemImage {
  url: string;
  altText: string | null;
}

export interface LineItemProduct {
  title: string;
  featuredImage: LineItemImage | null;
}

export interface LineItem {
  name: string;
  quantity: number;
  sku: string | null;
  image: LineItemImage | null;
  product: LineItemProduct | null;
}

export interface Order {
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
  rescheduleHistory: Metafield | null;
  shippingAddress: ShippingAddress | null;
  billingAddress: BillingAddress | null;
  note: string | null;
  currentTotalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  totalShippingPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  customAttributes: CustomAttribute[];
  lineItems: { edges: { node: LineItem }[] } | null;
}

export type BadgeTone =
  | "success"
  | "warning"
  | "critical"
  | "info"
  | "caution"
  | "neutral";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_SLOT_RE =
  /^\d{1,2}(:\d{2})?\s*(AM|PM)\s*[-–]\s*\d{1,2}(:\d{2})?\s*(AM|PM)$/i;

// ─── Date / time parsing helpers ──────────────────────────────────────────────

export function parseTimeWindowHour(tw: string): number {
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

export function parseDateValue(raw: string | null | undefined): number {
  if (!raw) return Infinity;
  const parts = raw.split("-");
  if (parts.length !== 3) return Infinity;
  return new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  ).getTime();
}

export function toLocalISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeDateToISO(value: string): string | null {
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

// ─── Date / money formatters ──────────────────────────────────────────────────

export function formatDeliveryDate(raw: string): string {
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

export function formatMoney(amount: string, currencyCode: string): string {
  const num = parseFloat(amount);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: currencyCode,
  });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

export function financialStatusTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (s === "paid") return "neutral";
  if (s === "pending" || s === "authorized") return "caution";
  if (s === "partially_paid") return "warning";
  if (s === "refunded" || s === "partially_refunded" || s === "voided")
    return "neutral";
  return "neutral";
}

export function isUnpaidStatus(status: string): boolean {
  return new Set(["pending", "authorized", "partially_paid"]).has(
    (status || "").toLowerCase(),
  );
}

export function fulfillmentStatusTone(status: string): BadgeTone {
  const s = status.toUpperCase();
  if (s === "FULFILLED") return "neutral";
  if (s === "PARTIALLY_FULFILLED") return "warning";
  if (s === "IN_PROGRESS") return "info";
  if (s === "UNFULFILLED" || s === "ON_HOLD" || s === "SCHEDULED")
    return "caution";
  if (s === "RESTOCKED") return "neutral";
  return "neutral";
}

export function isOpenFulfillmentStatus(status: string): boolean {
  return new Set(["UNFULFILLED", "ON_HOLD", "SCHEDULED"]).has(
    (status || "").toUpperCase(),
  );
}

export function formatStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

export function isHiddenDateTag(tag: string): boolean {
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

export function isHiddenTag(tag: string): boolean {
  if (isHiddenDateTag(tag)) return true;
  if (
    /^\d{1,2}(:\d{2})?\s*(AM|PM)\s*[-–]\s*\d{1,2}(:\d{2})?\s*(AM|PM)$/i.test(
      tag.trim(),
    )
  )
    return true;
  return false;
}

export function tagDisplayLabel(tag: string): string {
  const lower = tag.toLowerCase().trim();
  if (lower === "ops_md_checked") return "Checked";
  if (lower === "resched") return "Rescheduled";
  return tag.trim();
}

export function getMeaningfulTags(tags: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => !isHiddenTag(t));
}

// ─── Delivery relative / overdue helpers ──────────────────────────────────────

export function getDeliveryRelativeLabel(rawISO: string, todayISO: string): string {
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

export function isDeliveryOverdue(rawISO: string, todayISO: string): boolean {
  if (!rawISO || rawISO === "—") return false;
  const todayTs = parseDateValue(todayISO);
  const orderTs = parseDateValue(rawISO);
  return isFinite(todayTs) && isFinite(orderTs) && orderTs < todayTs;
}

// ─── Custom attribute helpers ─────────────────────────────────────────────────

export function findAttrValue(
  attrs: CustomAttribute[],
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const found = attrs.find((a) => a.key === key);
    if (found?.value) return found.value;
  }
  return null;
}

export function getDeliveryDateValue(order: Order): string {
  const attrs = order.customAttributes || [];
  const candidates = [
    order.customDate?.value,
    order.deliveryDate?.value,
    findAttrValue(attrs, "Delivery Date", "delivery.date", "sidekick.delivery_date"),
    (order.tags || []).find((t) => DATE_ISO_RE.test(t.trim()))?.trim(),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const iso = normalizeDateToISO(raw);
    if (iso) return iso;
  }
  return "—";
}

export function getDeliveryTimeValue(order: Order): string {
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

export function getCustomerName(order: Order): string {
  return order.customer
    ? [order.customer.firstName, order.customer.lastName]
        .filter(Boolean)
        .join(" ") || "—"
    : "—";
}

export function getOrderPhone(order: Order): string {
  return (
    order.customer?.defaultPhoneNumber?.phoneNumber ||
    order.shippingAddress?.phone ||
    "—"
  );
}

export function getCity(order: Order): string {
  return order.shippingAddress?.city || "—";
}

export function getInstructionValue(order: Order): string {
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

/**
 * Retrieves a custom attribute value by key, returning "—" if not found.
 * Thin wrapper over findAttrValue for OrderDrawer display fields.
 */
export function getAttr(attrs: CustomAttribute[], ...keys: string[]): string {
  for (const key of keys) {
    const found = attrs.find((a) => a.key === key);
    if (found?.value) return found.value;
  }
  return "—";
}

// ─── Filter helpers ──────────────────────────────────────────────────────────

export function normalizeTimeSlot(value: string): string {
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

// ─── Line item helpers ────────────────────────────────────────────────────────

export function getSearchableOrderText(order: Order): string {
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

export function getFirstItemImageUrl(order: Order): string | undefined {
  const item = order.lineItems?.edges?.[0]?.node ?? null;
  return item?.image?.url || item?.product?.featuredImage?.url || undefined;
}

export function getFirstItemAltText(order: Order): string {
  const item = order.lineItems?.edges?.[0]?.node ?? null;
  if (!item) return "Product image";
  return (
    item.image?.altText ||
    item.product?.featuredImage?.altText ||
    `Image of ${item.name}`
  );
}

// ─── Shipping address helpers ─────────────────────────────────────────────────

export function getFullShippingAddress(order: Order): string {
  const addr = order.shippingAddress;
  return addr
    ? [addr.address1, addr.address2].filter(Boolean).join(", ") || "—"
    : "—";
}

export function buildDeliveryInfoText(order: Order): string {
  const address1 = order.shippingAddress?.address1 ?? "";
  const city = order.shippingAddress?.city ?? "";
  const name = getCustomerName(order);
  const phone = getOrderPhone(order);
  return [address1, city, name, phone].filter(Boolean).join("\n");
}

// ─── Reschedule timeline helpers ──────────────────────────────────────────────

export type RescheduleTimelineEvent = {
  date: string;
  timeSlot: string;
  requestedAt: string;
  status: string;
};

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "—";
}

function getRescheduleHistorySource(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecordValue(value) && Array.isArray(value.events)) return value.events;
  if (isRecordValue(value) && Array.isArray(value.history))
    return value.history;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return getRescheduleHistorySource(JSON.parse(value));
  } catch {
    return [];
  }
}

export function getRescheduleTimelineEvents(order: Order): RescheduleTimelineEvent[] {
  const metafield = order.rescheduleHistory;
  const rawEvents = [
    ...getRescheduleHistorySource(metafield?.jsonValue),
    ...getRescheduleHistorySource(metafield?.value),
  ];
  const seen = new Set<string>();

  return rawEvents
    .flatMap((event): RescheduleTimelineEvent[] => {
      if (!isRecordValue(event)) return [];

      const timelineEvent = {
        date: getStringField(
          event,
          "date",
          "toDate",
          "newDate",
          "deliveryDate",
        ),
        timeSlot: getStringField(
          event,
          "timeSlot",
          "time_slot",
          "toTimeSlot",
          "newTimeSlot",
          "deliveryTimeSlot",
        ),
        requestedAt: getStringField(
          event,
          "requestedAt",
          "requested_at",
          "rescheduledAt",
          "createdAt",
          "updatedAt",
        ),
        status: getStringField(event, "status", "rescheduleStatus"),
      };

      if (
        timelineEvent.date === "—" &&
        timelineEvent.timeSlot === "—" &&
        timelineEvent.requestedAt === "—" &&
        timelineEvent.status === "—"
      ) {
        return [];
      }

      const fingerprint = JSON.stringify(timelineEvent);
      if (seen.has(fingerprint)) return [];
      seen.add(fingerprint);

      return [timelineEvent];
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.requestedAt);
      const bTime = Date.parse(b.requestedAt);
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return bTime - aTime;
    });
}

export function hasRescheduleTag(order: Order): boolean {
  return (order.tags || []).some(
    (tag) => tag.trim().toLowerCase() === "resched",
  );
}

export function formatTimelineDelivery(date: string, timeSlot: string): string {
  const formattedDate =
    date !== "—" ? formatDeliveryDate(normalizeDateToISO(date) ?? date) : "—";

  if (formattedDate === "—" && timeSlot === "—") return "—";
  if (formattedDate === "—") return timeSlot;
  if (timeSlot === "—") return formattedDate;
  return `${formattedDate} (${timeSlot})`;
}

export function formatTimelineTimestamp(value: string): string {
  if (value === "—") return "Requested time not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatTimelineStatus(value: string): string {
  return value === "—" ? "Status not recorded" : formatStatusLabel(value);
}
