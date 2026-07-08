import { authenticate, unauthenticated } from "../shopify.server";
import {
  isCartEligibleForMothersDay,
  isMothersDayRushDate,
  validateDeliverySelection,
} from "../lib/delivery-availability";
import { loadOrderMothersDayValidationItems } from "../services/mothers-day-validation.server";
import {
  extractDeliveryAttributesFromPayload,
  getOrderGidFromPayload,
  syncOrderDeliveryScheduleTag,
  syncOrderDeliveryMetafields,
} from "../services/order-delivery-metafields.server";
import { getScheduleRules } from "../services/schedule-rules.server";

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;
  const orderId = getOrderGidFromPayload(orderPayload);
  const { deliveryDate, timeSlot } =
    extractDeliveryAttributesFromPayload(orderPayload);

  console.log("[orders/create] webhook received.");

  if (!orderId || !deliveryDate || !timeSlot) {
    console.log(
      "[orders/create] delivery sync skipped: missing required delivery attributes.",
    );
    return new Response();
  }

  const { admin } = await unauthenticated.admin(shop);
  const scheduleRules = await getScheduleRules(shop);
  const selectionValidation = validateDeliverySelection(
    scheduleRules,
    deliveryDate,
    timeSlot,
  );
  if (!selectionValidation.ok) {
    console.warn("[orders/create] delivery sync blocked: invalid selection.");
    return new Response();
  }

  if (isMothersDayRushDate(deliveryDate)) {
    const validationItems = await loadOrderMothersDayValidationItems(
      admin,
      orderId,
    );
    if (!isCartEligibleForMothersDay(validationItems)) {
      console.warn(
        "[orders/create] Mother's Day delivery sync blocked: ineligible line item.",
      );
      return new Response();
    }
  }

  const result = await syncOrderDeliveryMetafields(admin, {
    orderId,
    deliveryDate,
    timeSlot,
  });

  if (!result.ok) {
    console.warn("[orders/create] delivery metafield sync failed.");
  }

  const tagResult = await syncOrderDeliveryScheduleTag(admin, {
    orderId,
    deliveryDate,
    timeSlot,
  });

  if (!tagResult.ok) {
    console.warn("[orders/create] delivery schedule tag sync failed.");
  } else if (tagResult.skipped) {
    console.log(
      "[orders/create] delivery schedule tags skipped: missing delivery date or time slot attribute.",
    );
  } else {
    console.log("[orders/create] delivery sync completed.");
  }

  return new Response();
};
