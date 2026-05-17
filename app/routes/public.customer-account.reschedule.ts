import { jwtVerify } from "jose";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  buildDeliveryTags,
  canRescheduleDelivery,
  isCartEligibleForMothersDay,
  isDeliveryScheduleTag,
  isMothersDayRushDate,
  MOTHERS_DAY_RESCHEDULE_ERROR_MESSAGE,
  validateDeliverySelection,
} from "../lib/delivery-availability";
import { loadOrderMothersDayValidationItems } from "../services/mothers-day-validation.server";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { unauthenticated } from "../shopify.server";

declare const process: {
  env: Record<string, string | undefined>;
};

const ORDER_CUSTOMER_QUERY = `#graphql
  query orderCustomer($id: ID!) {
    order(id: $id) {
      id
      tags
      displayFulfillmentStatus
      customAttributes {
        key
        value
      }
      currentDeliveryDate: metafield(namespace: "custom", key: "date") {
        value
      }
      customer {
        id
      }
    }
  }
`;

const SET_RESCHEDULE_METAFIELDS_MUTATION = `#graphql
  mutation setRescheduleMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        value
        namespace
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const REMOVE_ORDER_DELIVERY_TAGS_MUTATION = `#graphql
  mutation removeOrderDeliveryTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_ORDER_DELIVERY_TAGS_MUTATION = `#graphql
  mutation addOrderDeliveryTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION = `#graphql
  mutation updateOrderDeliveryAttributes($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const RECHECK_ORDER_STATE_QUERY = `#graphql
  query RecheckOrderState($id: ID!) {
    order(id: $id) {
      displayFulfillmentStatus
      tags
    }
  }
`;

const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";
const RESCHEDULED_ORDER_TAG = "resched";
const CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE =
  "This order has already been rescheduled once. Please contact us if you need further assistance.";
const CUSTOMER_RESCHEDULE_CLOSED_MESSAGE =
  "This delivery can no longer be rescheduled online because the delivery date is too close or has already passed. Please contact us for manual assistance.";
const CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE =
  "This order can no longer be rescheduled online because it is already being prepared or has been fulfilled. Please contact us for manual assistance.";
const CUSTOMER_RESCHEDULE_TIMEZONE = "Asia/Manila";
const ONLINE_RESCHEDULE_BLOCKED_FULFILLMENT_STATUSES = new Set([
  "FULFILLED",
  "PARTIALLY_FULFILLED",
  "IN_PROGRESS",
  "SCHEDULED",
]);

interface RescheduleRequestBody {
  orderId?: unknown;
  date?: unknown;
  timeSlot?: unknown;
  sessionToken?: unknown;
}

type SessionTokenPayload = {
  aud?: string;
  dest?: string;
  sub?: string;
};

type OrderCustomAttribute = {
  key: string;
  value: string;
};

const CUSTOMER_ACCOUNT_ORIGINS = new Set(["https://extensions.shopifycdn.com"]);

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function hasRescheduleTag(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some(
    (tag) => tag.trim().toLowerCase() === RESCHEDULED_ORDER_TAG,
  );
}

function isFulfilledForOnlineReschedule(
  status: string | null | undefined,
): boolean {
  return ONLINE_RESCHEDULE_BLOCKED_FULFILLMENT_STATUSES.has(
    (status ?? "").trim().toUpperCase(),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  return origin && CUSTOMER_ACCOUNT_ORIGINS.has(origin) ? origin : null;
}

function getCustomAttributeValue(
  attributes: OrderCustomAttribute[] | null | undefined,
  key: string,
): string | null {
  return attributes?.find((attribute) => attribute.key === key)?.value ?? null;
}

function getCurrentDeliveryDate(order: {
  currentDeliveryDate?: { value?: string | null } | null;
  customAttributes?: OrderCustomAttribute[] | null;
}): string | null {
  const metafieldValue = order.currentDeliveryDate?.value;
  if (isNonEmptyString(metafieldValue)) {
    return metafieldValue;
  }

  return getCustomAttributeValue(
    order.customAttributes,
    DELIVERY_DATE_ATTRIBUTE_KEY,
  );
}

function isCurrentDeliveryDateTooCloseOrPast(
  currentDeliveryDate: string | null | undefined,
  now = new Date(),
): boolean {
  if (
    !isNonEmptyString(currentDeliveryDate) ||
    !isValidDate(currentDeliveryDate)
  ) {
    return true;
  }

  return !canRescheduleDelivery(
    currentDeliveryDate,
    now,
    CUSTOMER_RESCHEDULE_TIMEZONE,
  );
}

function createHmacKey(secret: string): Uint8Array {
  const key = new Uint8Array(secret.length);
  for (let index = 0; index < secret.length; index += 1) {
    key[index] = secret.charCodeAt(index);
  }
  return key;
}

function extractExistingDeliveryTags(
  currentTags: string[] | null | undefined,
): string[] {
  // Customer-account reschedules bypass the order-created Flow trigger, so this route
  // removes only the canonical schedule tags and leaves every other order tag alone.
  const deliveryTags: string[] = [];
  const seenTags = new Set<string>();

  for (const rawTag of currentTags ?? []) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (!isDeliveryScheduleTag(tag)) {
      continue;
    }
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);
    deliveryTags.push(tag);
  }

  return deliveryTags;
}

function buildNextDeliveryTags(date: string, timeSlot: string): string[] {
  return buildDeliveryTags(date, timeSlot);
}

function buildNextDeliveryCustomAttributes(
  currentAttributes: OrderCustomAttribute[] | null | undefined,
  date: string,
  timeSlot: string,
): OrderCustomAttribute[] {
  const nextAttributes: OrderCustomAttribute[] = [];
  let hasDeliveryDate = false;
  let hasDeliveryTime = false;

  for (const attribute of currentAttributes ?? []) {
    const key = attribute.key.trim();
    if (!key) continue;

    if (key === DELIVERY_DATE_ATTRIBUTE_KEY) {
      nextAttributes.push({ key, value: date });
      hasDeliveryDate = true;
      continue;
    }

    if (key === DELIVERY_TIME_ATTRIBUTE_KEY) {
      nextAttributes.push({ key, value: timeSlot });
      hasDeliveryTime = true;
      continue;
    }

    nextAttributes.push({ key, value: attribute.value });
  }

  if (!hasDeliveryDate) {
    nextAttributes.push({ key: DELIVERY_DATE_ATTRIBUTE_KEY, value: date });
  }

  if (!hasDeliveryTime) {
    nextAttributes.push({ key: DELIVERY_TIME_ATTRIBUTE_KEY, value: timeSlot });
  }

  return nextAttributes;
}

type TagMutationError = {
  field?: string[];
  message: string;
};

type TagMutationResponse = {
  data?: {
    tagsAdd?: {
      userErrors?: TagMutationError[];
    };
    tagsRemove?: {
      userErrors?: TagMutationError[];
    };
  };
  errors?: Array<{ message: string }>;
};

type OrderUpdateResponse = {
  data?: {
    orderUpdate?: {
      userErrors?: TagMutationError[];
    };
  };
  errors?: Array<{ message: string }>;
};

function buildResponseHeaders(request: Request): Headers {
  // Customer-account extensions post to this route from Shopify's CDN origin, so the
  // response must include explicit CORS headers for the browser request to complete.
  const headers = new Headers({
    "Cache-Control": "no-store",
    Vary: "Origin",
  });

  const allowedOrigin = isAllowedOrigin(request);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }

  return headers;
}

function emptyResponse(request: Request, status = 204): Response {
  return new Response(null, {
    status,
    headers: buildResponseHeaders(request),
  });
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: buildResponseHeaders(request),
  });
}

function orderUnavailableResponse(request: Request): Response {
  return jsonResponse(
    request,
    { ok: false, error: "Order not found or unavailable" },
    404,
  );
}

async function parseRequestBody(
  request: Request,
): Promise<RescheduleRequestBody> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as RescheduleRequestBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formBody = await request.text();
    const searchParams = new URLSearchParams(formBody);

    return {
      orderId: searchParams.get("orderId"),
      date: searchParams.get("date"),
      timeSlot: searchParams.get("timeSlot"),
      sessionToken: searchParams.get("sessionToken"),
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return {
      orderId: formData.get("orderId"),
      date: formData.get("date"),
      timeSlot: formData.get("timeSlot"),
      sessionToken: formData.get("sessionToken"),
    };
  }

  throw new Error("Unsupported content type");
}

function extractShopFromSessionToken(
  sessionToken: SessionTokenPayload,
): string | null {
  const dest = sessionToken.dest;
  if (!isNonEmptyString(dest)) return null;

  try {
    const url =
      dest.startsWith("http://") || dest.startsWith("https://")
        ? new URL(dest)
        : new URL(`https://${dest}`);
    return url.host;
  } catch {
    return null;
  }
}

async function validateCustomerAccountSessionToken(
  sessionToken: string,
): Promise<SessionTokenPayload> {
  // Verify the lightweight extension token before trusting the customer or shop claims
  // in a browser-initiated reschedule write.
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("Shopify app credentials are not configured");
  }

  const { payload } = await jwtVerify(sessionToken, createHmacKey(apiSecret), {
    algorithms: ["HS256"],
    clockTolerance: 10,
  });

  if (payload.aud !== apiKey) {
    throw new Error("Session token had invalid API key");
  }

  return payload as SessionTokenPayload;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return emptyResponse(request);
  }

  return jsonResponse(request, { ok: false, error: "Method not allowed" }, 405);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return emptyResponse(request);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      request,
      { ok: false, error: "Method not allowed" },
      405,
    );
  }

  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin && !isAllowedOrigin(request)) {
    return jsonResponse(request, { ok: false, error: "Invalid origin" }, 403);
  }

  let body: RescheduleRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse(
      request,
      { ok: false, error: "Invalid request body" },
      400,
    );
  }

  const { orderId, date, timeSlot, sessionToken } = body;

  if (!isNonEmptyString(sessionToken)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  let verifiedSessionToken: SessionTokenPayload;
  try {
    verifiedSessionToken =
      await validateCustomerAccountSessionToken(sessionToken);
  } catch (error) {
    console.warn("[customer-account reschedule] invalid session token:", error);
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const customerGid = verifiedSessionToken.sub;
  if (!isNonEmptyString(customerGid)) {
    return jsonResponse(request, { ok: false, error: "Unauthorized" }, 401);
  }

  const shop = extractShopFromSessionToken(verifiedSessionToken);
  if (!shop) {
    return jsonResponse(
      request,
      { ok: false, error: "Invalid shop context" },
      400,
    );
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    if (!isNonEmptyString(orderId)) {
      return jsonResponse(
        request,
        { ok: false, error: "orderId is required" },
        400,
      );
    }
    if (!isNonEmptyString(date) || !isValidDate(date)) {
      return jsonResponse(
        request,
        { ok: false, error: "date must be a valid YYYY-MM-DD string" },
        400,
      );
    }
    if (!isNonEmptyString(timeSlot)) {
      return jsonResponse(
        request,
        { ok: false, error: "timeSlot is required" },
        400,
      );
    }

    const orderGid = orderId.startsWith("gid://")
      ? orderId
      : `gid://shopify/Order/${orderId}`;

    const orderOwnerResponse = await admin.graphql(ORDER_CUSTOMER_QUERY, {
      variables: { id: orderGid },
    });

    const orderOwnerResult = (await orderOwnerResponse.json()) as {
      data?: {
        order?: {
          tags?: string[] | null;
          displayFulfillmentStatus?: string | null;
          customAttributes?: OrderCustomAttribute[] | null;
          currentDeliveryDate?: { value?: string | null } | null;
          customer?: { id?: string | null } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (orderOwnerResult.errors?.length) {
      console.error(
        "[customer-account reschedule] order lookup errors:",
        orderOwnerResult.errors,
      );
      return jsonResponse(
        request,
        { ok: false, error: "Failed to validate order" },
        500,
      );
    }

    const order = orderOwnerResult.data?.order ?? null;
    if (!order) {
      return orderUnavailableResponse(request);
    }

    const orderCustomerId = order.customer?.id ?? null;
    // Confirm order ownership before validating or writing anything so a signed-in
    // customer can only reschedule their own order without revealing whether another
    // submitted order ID exists.
    if (!orderCustomerId || orderCustomerId !== customerGid) {
      return orderUnavailableResponse(request);
    }

    if (
      isFulfilledForOnlineReschedule(
        order.displayFulfillmentStatus,
      )
    ) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE,
          code: "order_already_fulfilled",
        },
        422,
      );
    }

    if (hasRescheduleTag(order.tags)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE,
          code: "already_rescheduled_once",
        },
        422,
      );
    }

    const currentDeliveryDate = getCurrentDeliveryDate(order);
    if (isCurrentDeliveryDateTooCloseOrPast(currentDeliveryDate)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_CLOSED_MESSAGE,
          code: "current_delivery_date_too_close_or_past",
        },
        422,
      );
    }

    // Reuse the shared delivery rules contract here so the customer-account flow stays
    // in parity with storefront and admin availability decisions.
    const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin);
    const validation = validateDeliverySelection(scheduleRules, date, timeSlot);
    if (!validation.ok) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: isMothersDayRushDate(date)
            ? MOTHERS_DAY_RESCHEDULE_ERROR_MESSAGE
            : validation.message,
          code: validation.code,
          minDate: validation.minDate,
          maxDate: validation.maxDate,
          availableSlots: validation.availableSlots.map((slot) => ({
            display: slot.display,
            value: slot.value,
          })),
        },
        422,
      );
    }

    if (isMothersDayRushDate(date)) {
      const validationItems = await loadOrderMothersDayValidationItems(
        admin,
        orderGid,
      );
      if (!isCartEligibleForMothersDay(validationItems)) {
        return jsonResponse(
          request,
          {
            ok: false,
            error: MOTHERS_DAY_RESCHEDULE_ERROR_MESSAGE,
            code: "mothers_day_product_ineligible",
          },
          422,
        );
      }
    }

    // Re-read the two fields that can change while this request was validating.
    // A concurrent reschedule or fulfillment between the first fetch and the mutations
    // below would otherwise pass every guard on stale data.
    const recheckResponse = await admin.graphql(RECHECK_ORDER_STATE_QUERY, {
      variables: { id: orderGid },
    });
    const recheckResult = (await recheckResponse.json()) as {
      data?: {
        order?: {
          displayFulfillmentStatus?: string | null;
          tags?: string[] | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (recheckResult.errors?.length || !recheckResult.data?.order) {
      return jsonResponse(
        request,
        { ok: false, error: "Failed to verify order state before rescheduling" },
        500,
      );
    }

    if (isFulfilledForOnlineReschedule(recheckResult.data.order.displayFulfillmentStatus)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_FULFILLED_MESSAGE,
          code: "order_already_fulfilled",
        },
        422,
      );
    }

    if (hasRescheduleTag(recheckResult.data.order.tags)) {
      return jsonResponse(
        request,
        {
          ok: false,
          error: CUSTOMER_RESCHEDULE_ALREADY_RESCHEDULED_MESSAGE,
          code: "already_rescheduled_once",
        },
        422,
      );
    }

    const rescheduledAt = new Date().toISOString();
    // Persist the confirmed selection onto order metafields so every downstream admin
    // and customer-account surface can read the same delivery source of truth.
    const metafields = [
      {
        ownerId: orderGid,
        namespace: "custom",
        key: "date",
        value: date,
        type: "date",
      },
      {
        ownerId: orderGid,
        namespace: "custom",
        key: "time_slot",
        value: timeSlot,
        type: "single_line_text_field",
      },
      {
        ownerId: orderGid,
        namespace: "$app",
        key: "reschedule_status",
        value: "confirmed",
        type: "single_line_text_field",
      },
      {
        ownerId: orderGid,
        namespace: "$app",
        key: "reschedule_requested_at",
        value: rescheduledAt,
        type: "date_time",
      },
    ];

    const response = await admin.graphql(SET_RESCHEDULE_METAFIELDS_MUTATION, {
      variables: { metafields },
    });

    const result = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors: Array<{ field: string[]; message: string; code: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors?.length) {
      console.error(
        "[customer-account reschedule] GraphQL errors:",
        result.errors,
      );
      return jsonResponse(
        request,
        { ok: false, error: "Failed to save reschedule request" },
        500,
      );
    }

    const userErrors = result.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.warn(
        "[customer-account reschedule] metafieldsSet userErrors:",
        userErrors,
      );
      return jsonResponse(
        request,
        {
          ok: false,
          error: userErrors[0].message ?? "Failed to save reschedule request",
        },
        422,
      );
    }

    const nextDeliveryAttributes = buildNextDeliveryCustomAttributes(
      order.customAttributes,
      date,
      timeSlot,
    );
    let attributeSyncFailed = false;

    const attributeSyncResponse = await admin.graphql(
      UPDATE_ORDER_DELIVERY_ATTRIBUTES_MUTATION,
      {
        variables: {
          input: {
            id: orderGid,
            customAttributes: nextDeliveryAttributes,
          },
        },
      },
    );

    const attributeSyncResult =
      (await attributeSyncResponse.json()) as OrderUpdateResponse;
    const attributeSyncUserErrors =
      attributeSyncResult.data?.orderUpdate?.userErrors ?? [];

    if (
      attributeSyncResult.errors?.length ||
      attributeSyncUserErrors.length > 0
    ) {
      attributeSyncFailed = true;
    }

    // Mirror the canonical metafield values into the legacy order attributes and
    // delivery schedule tags here because customer-account reschedules do not pass
    // back through the order-created Flow.
    const existingDeliveryTags = extractExistingDeliveryTags(
      order.tags,
    );
    const nextDeliveryTags = buildNextDeliveryTags(date, timeSlot);
    const nextOrderTags = Array.from(
      new Set([...nextDeliveryTags, RESCHEDULED_ORDER_TAG]),
    );
    let tagSyncFailed = false;

    if (existingDeliveryTags.length > 0) {
      const removeTagsResponse = await admin.graphql(
        REMOVE_ORDER_DELIVERY_TAGS_MUTATION,
        {
          variables: {
            id: orderGid,
            tags: existingDeliveryTags,
          },
        },
      );

      const removeTagsResult =
        (await removeTagsResponse.json()) as TagMutationResponse;
      const removeTagUserErrors =
        removeTagsResult.data?.tagsRemove?.userErrors ?? [];

      if (removeTagsResult.errors?.length || removeTagUserErrors.length > 0) {
        tagSyncFailed = true;
      }
    }

    if (!tagSyncFailed && nextOrderTags.length > 0) {
      const addTagsResponse = await admin.graphql(
        ADD_ORDER_DELIVERY_TAGS_MUTATION,
        {
          variables: {
            id: orderGid,
            tags: nextOrderTags,
          },
        },
      );

      const addTagsResult =
        (await addTagsResponse.json()) as TagMutationResponse;
      const addTagUserErrors = addTagsResult.data?.tagsAdd?.userErrors ?? [];

      if (addTagsResult.errors?.length || addTagUserErrors.length > 0) {
        tagSyncFailed = true;
      }
    }

    return jsonResponse(request, {
      ok: true,
      orderId: orderGid,
      rescheduledAt,
      rescheduleStatus: "confirmed",
      newDate: date,
      newTimeSlot: timeSlot,
      deliveryAttributeSync: attributeSyncFailed ? "failed" : "updated",
      deliveryTagSync: tagSyncFailed ? "failed" : "updated",
    });
  } catch (error) {
    console.error(
      "[customer-account reschedule] failed to save reschedule:",
      error,
    );
    return jsonResponse(
      request,
      { ok: false, error: "Failed to save reschedule request" },
      500,
    );
  }
};
