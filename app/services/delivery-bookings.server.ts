import type { DeliveryScheduleRules } from "./schedule-rules.server";

interface AdminGraphQLResponseError {
  message: string;
}

interface DeliveryOrderAttribute {
  key: string;
  value: string;
}

interface DeliveryMetafield {
  value?: string | null;
}

interface DeliveryOrderNode {
  cancelledAt: string | null;
  customAttributes: DeliveryOrderAttribute[];
  tags: string[];
  deliveryDateMetafield?: DeliveryMetafield | null;
  timeSlotMetafield?: DeliveryMetafield | null;
}

interface DeliveryOrdersQueryResponse {
  data?: {
    orders?: {
      edges: Array<{ node: DeliveryOrderNode }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: AdminGraphQLResponseError[];
}

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const FETCH_DELIVERY_ORDERS_QUERY = `#graphql
  query FetchDeliveryOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          cancelledAt
          customAttributes {
            key
            value
          }
          tags
          deliveryDateMetafield: metafield(namespace: "custom", key: "date") {
            value
          }
          timeSlotMetafield: metafield(namespace: "custom", key: "time_slot") {
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";
const TIME_SLOT_RE = /^\d{1,2}(?::\d{2})?(AM|PM)-\d{1,2}(?::\d{2})?(AM|PM)$/i;
const DEFAULT_LOOKBACK_DAYS = 35;
const ORDER_PAGE_SIZE = 250;
const MAX_ORDER_PAGES = 20;

function extractOrderAttributeValue(
  order: DeliveryOrderNode,
  key: string,
): string | null {
  const attribute = order.customAttributes.find((entry) => entry.key === key);
  const value = attribute?.value.trim();

  return value ? value : null;
}

function extractMetafieldValue(
  metafield: DeliveryMetafield | null | undefined,
): string | null {
  const value = metafield?.value?.trim();
  return value ? value : null;
}

function normalizeTaggedDeliveryDate(raw: string): string | null {
  const trimmed = raw.trim();
  const lowerValue = trimmed.toLowerCase();
  const value = lowerValue.startsWith("delivery:")
    ? trimmed.slice("delivery:".length).trim()
    : lowerValue.startsWith("delivery date:")
      ? trimmed.slice("delivery date:".length).trim()
      : trimmed;

  const legacyScheduleMatch = value.match(/^(\d{4}-\d{2}-\d{2})\s*\|\s*.+$/);
  if (legacyScheduleMatch) return legacyScheduleMatch[1];

  const deliveryTagMatch = value.match(/^(\d{4}-\d{2}-\d{2})(?:\s*\[.+\])?$/);
  if (deliveryTagMatch) return deliveryTagMatch[1];

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const usMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month}-${day}`;
  }

  return null;
}

function normalizeTimeSlotValue(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const compactValue = trimmed.replace(/\s+/g, "").toUpperCase();
  if (!TIME_SLOT_RE.test(compactValue)) return null;

  return trimmed.includes(":") || trimmed.includes(" ")
    ? trimmed.replace(/\s*-\s*/, " - ")
    : compactValue;
}

// Keep counting compatible with legacy tag and attribute storage so existing orders
// still contribute to slot capacity while the rest of the delivery flow evolves.
function getDeliveryDateFromTag(order: DeliveryOrderNode): string | null {
  for (const tag of order.tags) {
    const normalized = normalizeTaggedDeliveryDate(tag);
    if (normalized) return normalized;
  }

  return null;
}

export function getDeliveryDate(order: DeliveryOrderNode): string | null {
  const metafieldValue = extractMetafieldValue(order.deliveryDateMetafield);
  if (metafieldValue) {
    const normalized = normalizeTaggedDeliveryDate(metafieldValue);
    if (normalized) return normalized;
  }

  const attributeValue = extractOrderAttributeValue(
    order,
    DELIVERY_DATE_ATTRIBUTE_KEY,
  );
  return attributeValue
    ? normalizeTaggedDeliveryDate(attributeValue)
    : getDeliveryDateFromTag(order);
}

function getTimeSlotFromTag(order: DeliveryOrderNode): string | null {
  for (const tag of order.tags) {
    const trimmedTag = tag.trim();
    const legacyScheduleMatch = trimmedTag.match(
      /^\d{4}-\d{2}-\d{2}\s*\|\s*(.+)$/,
    );
    if (legacyScheduleMatch) {
      return normalizeTimeSlotValue(legacyScheduleMatch[1]);
    }

    const deliveryTagMatch = trimmedTag.match(
      /^delivery:\s*\d{4}-\d{2}-\d{2}\s*\[(.+)\]$/i,
    );
    if (deliveryTagMatch) {
      return normalizeTimeSlotValue(deliveryTagMatch[1]);
    }

    if (trimmedTag.toLowerCase().startsWith("delivery time:")) {
      return normalizeTimeSlotValue(trimmedTag.slice("delivery time:".length));
    }

    const valueOnlyTimeSlot = normalizeTimeSlotValue(trimmedTag);
    if (valueOnlyTimeSlot) return valueOnlyTimeSlot;
  }

  return null;
}

export function getTimeSlot(order: DeliveryOrderNode): string | null {
  const metafieldValue = extractMetafieldValue(order.timeSlotMetafield);
  if (metafieldValue) {
    const normalized = normalizeTimeSlotValue(metafieldValue);
    if (normalized) return normalized;
  }

  const attributeValue = extractOrderAttributeValue(
    order,
    DELIVERY_TIME_ATTRIBUTE_KEY,
  );
  return attributeValue
    ? normalizeTimeSlotValue(attributeValue)
    : getTimeSlotFromTag(order);
}

export function normalizeDeliveryDateValue(raw: string): string | null {
  return normalizeTaggedDeliveryDate(raw);
}

export function normalizeDeliveryTimeSlotValue(raw: string): string | null {
  return normalizeTimeSlotValue(raw);
}

export type { DeliveryOrderNode };

function getPastDateString(timezone: string, daysAgo: number): string {
  return new Date(
    Date.now() - daysAgo * 24 * 60 * 60 * 1000,
  ).toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
}

function extractGraphQLErrorMessage(
  errors: AdminGraphQLResponseError[] | undefined,
  fallback: string,
) {
  if (!errors?.length) {
    return fallback;
  }

  return errors.map((error) => error.message).join(", ");
}

export async function loadAutomaticBookedCounts(
  admin: AdminGraphQLClient,
  rules: DeliveryScheduleRules,
): Promise<Record<string, Record<string, number>>> {
  const configuredDates = Object.keys(rules.slotCapacity);
  if (!configuredDates.length) {
    return {};
  }

  const configuredSlotsByDate = new Map(
    Object.entries(rules.slotCapacity).map(([date, capacities]) => [
      date,
      new Set(Object.keys(capacities)),
    ]),
  );
  const bookedCounts: Record<string, Record<string, number>> = {};
  // Bound the lookback and pagination so live booked counts stay representative of the
  // active delivery window without turning every rules read into an unbounded scan.
  const lookbackDays = Math.max(DEFAULT_LOOKBACK_DAYS, rules.maxDays);
  const query = `created_at:>=${getPastDateString(rules.timezone, lookbackDays)}`;

  let cursor: string | null = null;

  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const response = await admin.graphql(FETCH_DELIVERY_ORDERS_QUERY, {
      variables: {
        first: ORDER_PAGE_SIZE,
        after: cursor,
        query,
      },
    });

    const responseJson = (await response.json()) as DeliveryOrdersQueryResponse;
    if (!response.ok || responseJson.errors?.length) {
      throw new Error(
        extractGraphQLErrorMessage(
          responseJson.errors,
          "Failed to load delivery orders.",
        ),
      );
    }

    const orders = responseJson.data?.orders;
    if (!orders) {
      return bookedCounts;
    }

    for (const edge of orders.edges) {
      const order = edge.node;
      // Skip cancelled orders and any unconfigured date/slot pairs so capacity is only
      // driven by live orders that still compete for a configured delivery bucket.
      if (order.cancelledAt) {
        continue;
      }

      const deliveryDate = getDeliveryDate(order);
      if (!deliveryDate || !configuredSlotsByDate.has(deliveryDate)) {
        continue;
      }

      const timeSlot = getTimeSlot(order);
      if (
        !timeSlot ||
        !configuredSlotsByDate.get(deliveryDate)?.has(timeSlot)
      ) {
        continue;
      }

      bookedCounts[deliveryDate] ??= {};
      bookedCounts[deliveryDate][timeSlot] =
        (bookedCounts[deliveryDate][timeSlot] ?? 0) + 1;
    }

    if (!orders.pageInfo.hasNextPage || !orders.pageInfo.endCursor) {
      return bookedCounts;
    }

    cursor = orders.pageInfo.endCursor;
  }

  return bookedCounts;
}
