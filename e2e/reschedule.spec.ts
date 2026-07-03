import { expect, test } from "@playwright/test";

import {
  adminGraphQL,
  mintSessionToken,
  ORDER_DELIVERY_QUERY,
  type OrderCustomAttribute,
  type OrderDelivery,
} from "./helpers";

/**
 * End-to-end validation of the customer-account reschedule flow.
 *
 * Required env vars:
 *   APP_URL                  – Public URL of the deployed delivery-scheduler app
 *                              (e.g. https://delivery-scheduler-XXXX.run.app)
 *   SHOPIFY_API_KEY          – App API key (= session token aud)
 *   SHOPIFY_API_SECRET       – App API secret (HS256 signing key)
 *   SHOP_DOMAIN              – e.g. hsrwva-nr.myshopify.com
 *   ADMIN_ACCESS_TOKEN       – Optional offline admin token with read_orders / write_orders
 *                              (shpua_…). If omitted, the test falls back to the app's
 *                              stored offline session in Prisma.
 *   TEST_ORDER_GID           – Order to reschedule, e.g. gid://shopify/Order/6909438427323
 *   TEST_CUSTOMER_GID        – Owner of TEST_ORDER_GID, e.g. gid://shopify/Customer/123
 *   TEST_NEW_DATE            – YYYY-MM-DD, must be allowed by schedule rules
 *   TEST_NEW_TIME_SLOT       – e.g. "3PM-6PM"
 *
 * The test does NOT create new orders. Order creation is intentionally out of
 * scope because the reschedule route is the unit under test and creating real
 * orders against a live store from CI is destructive. Use a known seed order.
 */

const env = (key: string): string => {
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const getCustomAttributeValues = (
  attributes: OrderCustomAttribute[] | undefined,
  key: string,
): string[] => {
  return (attributes ?? [])
    .filter((attribute) => attribute.key === key)
    .map((attribute) => attribute.value);
};

const DELIVERY_SCHEDULE_TAG_PATTERN =
  /^(Delivery Date:\s*\d{4}-\d{2}-\d{2}|Delivery Time:\s*.+|Delivery:\s*\d{4}-\d{2}-\d{2}\s*\[.+\]|\d{4}-\d{2}-\d{2}\s*\|\s*.+|\d{4}-\d{2}-\d{2}|\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*-\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM))$/i;

test.describe("customer-account reschedule -> order tag + metafield sync", () => {
  test("metafields, delivery schedule tags, and legacy delivery attributes reflect the new selection", async ({
    request,
  }) => {
    const apiKey = env("SHOPIFY_API_KEY");
    const apiSecret = env("SHOPIFY_API_SECRET");
    const shopDomain = env("SHOP_DOMAIN");
    const adminAccessToken = process.env.ADMIN_ACCESS_TOKEN?.trim();
    const orderGid = env("TEST_ORDER_GID");
    const customerGid = env("TEST_CUSTOMER_GID");
    const newDate = env("TEST_NEW_DATE");
    const newTimeSlot = env("TEST_NEW_TIME_SLOT");
    const expectedScheduleTags = [newDate, newTimeSlot].sort();

    // 1. Capture pre-reschedule state for diagnostics.
    const before = await adminGraphQL<OrderDelivery>({
      shopDomain,
      adminAccessToken,
      query: ORDER_DELIVERY_QUERY,
      variables: { id: orderGid },
    });
    expect(before.errors, "admin GraphQL errors before reschedule").toBeFalsy();
    expect(before.data?.order, "order must exist").not.toBeNull();
    const preservedNonScheduleTags = [...(before.data?.order?.tags ?? [])]
      .filter((tag) => !DELIVERY_SCHEDULE_TAG_PATTERN.test(tag.trim()))
      .sort();

    // 2. Mint a customer-account session token and call the reschedule route.
    const sessionToken = await mintSessionToken({
      apiKey,
      apiSecret,
      shopDomain,
      customerGid,
    });

    const submitReschedule = async () => {
      const response = await request.post(
        "/public/customer-account/reschedule",
        {
          headers: {
            Origin: "https://extensions.shopifycdn.com",
            "Content-Type": "application/json",
          },
          data: {
            orderId: orderGid,
            date: newDate,
            timeSlot: newTimeSlot,
            sessionToken,
          },
        },
      );

      const responseBodyText = await response.text();
      expect(
        response.status(),
        `reschedule HTTP status (body: ${responseBodyText})`,
      ).toBe(200);

      const body = JSON.parse(responseBodyText) as {
        ok: boolean;
        error?: string;
        deliveryAttributeSync?: "updated" | "failed";
        deliveryTagSync?: "updated" | "failed";
      };

      expect(body.ok, `reschedule failed: ${body.error}`).toBe(true);
      expect(body.deliveryAttributeSync, "delivery attribute sync status").toBe(
        "updated",
      );
      expect(body.deliveryTagSync, "delivery tag sync status").toBe("updated");

      return body;
    };

    await submitReschedule();
    // Repeat the same reschedule to prove tag replacement stays idempotent.
    await submitReschedule();

    // 3. Verify order metafields and tags via Admin API.
    //    Shopify is eventually consistent on tag indexing for some queries,
    //    so allow a short polling window before failing.
    await expect
      .poll(
        async () => {
          const after = await adminGraphQL<OrderDelivery>({
            shopDomain,
            adminAccessToken,
            query: ORDER_DELIVERY_QUERY,
            variables: { id: orderGid },
          });
          const order = after.data?.order;
          if (!order) return null;
          const tags = order.tags ?? [];
          return {
            scheduleTags: tags
              .filter((tag) => DELIVERY_SCHEDULE_TAG_PATTERN.test(tag.trim()))
              .sort(),
            date: order.date?.value ?? null,
            timeSlot: order.timeSlot?.value ?? null,
            deliveryDateAttributes: getCustomAttributeValues(
              order.customAttributes,
              "Delivery Date",
            ),
            deliveryTimeAttributes: getCustomAttributeValues(
              order.customAttributes,
              "Delivery Time",
            ),
          };
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toMatchObject({
        scheduleTags: expectedScheduleTags,
        date: newDate,
        timeSlot: newTimeSlot,
        deliveryDateAttributes: [newDate],
        deliveryTimeAttributes: [newTimeSlot],
      });

    const after = await adminGraphQL<OrderDelivery>({
      shopDomain,
      adminAccessToken,
      query: ORDER_DELIVERY_QUERY,
      variables: { id: orderGid },
    });

    const order = after.data?.order;
    expect(order, "order present after reschedule").toBeTruthy();

    const tags = order?.tags ?? [];
    const scheduleTags = tags
      .filter((tag) => DELIVERY_SCHEDULE_TAG_PATTERN.test(tag.trim()))
      .sort();
    expect(
      scheduleTags,
      `expected exactly two delivery schedule tags ${JSON.stringify(expectedScheduleTags)} in ${JSON.stringify(tags)}`,
    ).toEqual(expectedScheduleTags);

    const nonScheduleTags = tags
      .filter((tag) => !DELIVERY_SCHEDULE_TAG_PATTERN.test(tag.trim()))
      .sort();
    expect(
      nonScheduleTags,
      `non-schedule tags should be preserved across reschedules: ${JSON.stringify(tags)}`,
    ).toEqual(preservedNonScheduleTags);

    // Cross-check: metafields and tags carry identical values.
    expect(order?.date?.value).toBe(newDate);
    expect(order?.timeSlot?.value).toBe(newTimeSlot);

    const deliveryDateAttributes = getCustomAttributeValues(
      order?.customAttributes,
      "Delivery Date",
    );
    const deliveryTimeAttributes = getCustomAttributeValues(
      order?.customAttributes,
      "Delivery Time",
    );

    expect(
      deliveryDateAttributes,
      `expected Delivery Date custom attribute to equal ${newDate} in ${JSON.stringify(order?.customAttributes ?? [])}`,
    ).toEqual([newDate]);
    expect(
      deliveryTimeAttributes,
      `expected Delivery Time custom attribute to equal ${newTimeSlot} in ${JSON.stringify(order?.customAttributes ?? [])}`,
    ).toEqual([newTimeSlot]);
  });
});
