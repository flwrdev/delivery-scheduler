import { unauthenticated } from "../shopify.server";

const SET_ORDER_LALAMOVE_METAFIELDS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;

const GET_FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 30) {
            nodes { id remainingQuantity }
          }
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

interface LalamoveWebhookPayload {
  eventType: string;
  orderId?: string;
  status?: string;
  driverId?: string;
  driver?: {
    name: string;
    phone: string;
  };
  metadata?: Record<string, string>;
}

async function setOrderMetafields(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
  shopifyOrderId: string,
  fields: Record<string, string>,
) {
  const metafields = Object.entries(fields).map(([key, value]) => ({
    ownerId: shopifyOrderId,
    namespace: "lalamove",
    key,
    value,
    type: "single_line_text_field",
  }));
  await admin.graphql(SET_ORDER_LALAMOVE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });
}

export const action = async ({ request }: { request: Request }) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: LalamoveWebhookPayload;
  try {
    payload = (await request.json()) as LalamoveWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const shopifyOrderId = payload.metadata?.shopifyOrderId;
  const shop = payload.metadata?.shop;

  if (!shopifyOrderId || !shop) {
    console.warn(
      "[webhooks/lalamove] Missing shopifyOrderId or shop in metadata. Skipping.",
    );
    return new Response(null, { status: 200 });
  }

  const { admin } = await unauthenticated.admin(shop);
  const { eventType } = payload;

  if (eventType === "DRIVER_ASSIGNED") {
    const driverName = payload.driver?.name ?? "";
    const driverPhone = payload.driver?.phone ?? "";

    await setOrderMetafields(admin, shopifyOrderId, {
      status: "ON_GOING",
      driver_name: driverName,
      driver_phone: driverPhone,
    });

    // Create Shopify fulfillment with tracking URL → triggers customer shipping email
    try {
      const foRes = await admin.graphql(GET_FULFILLMENT_ORDERS_QUERY, {
        variables: { id: shopifyOrderId },
      });
      const foBody = (await foRes.json()) as {
        data?: {
          order?: {
            fulfillmentOrders?: {
              nodes: Array<{
                id: string;
                status: string;
                lineItems: {
                  nodes: Array<{ id: string; remainingQuantity: number }>;
                };
              }>;
            };
          };
        };
      };

      const openFO = foBody.data?.order?.fulfillmentOrders?.nodes?.find(
        (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS",
      );

      if (openFO) {
        const fulfillableItems = openFO.lineItems.nodes.filter(
          (li) => li.remainingQuantity > 0,
        );

        if (fulfillableItems.length > 0) {
          const shareLinkRes = await admin.graphql(
            `query GetShareLink($id: ID!) {
              order(id: $id) {
                lalamoveShareLink: metafield(namespace: "lalamove", key: "share_link") { value }
              }
            }`,
            { variables: { id: shopifyOrderId } },
          );
          const shareLinkBody = (await shareLinkRes.json()) as {
            data?: {
              order?: { lalamoveShareLink?: { value: string } | null };
            };
          };
          const trackingUrl =
            shareLinkBody.data?.order?.lalamoveShareLink?.value ?? "";

          await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
            variables: {
              fulfillment: {
                lineItemsByFulfillmentOrder: [
                  {
                    fulfillmentOrderId: openFO.id,
                    fulfillmentOrderLineItems: fulfillableItems.map((li) => ({
                      id: li.id,
                      quantity: li.remainingQuantity,
                    })),
                  },
                ],
                notifyCustomer: true,
                ...(trackingUrl
                  ? { trackingInfo: { url: trackingUrl, company: "Lalamove" } }
                  : {}),
              },
            },
          });
        }
      }
    } catch (e) {
      console.warn("[webhooks/lalamove] Fulfillment creation failed:", e);
    }
  }

  if (eventType === "ORDER_STATUS_CHANGED" && payload.status) {
    await setOrderMetafields(admin, shopifyOrderId, {
      status: payload.status,
    });
  }

  if (eventType === "POD_STATUS_CHANGED") {
    await setOrderMetafields(admin, shopifyOrderId, {
      status: "COMPLETED",
    });
  }

  return new Response(null, { status: 200 });
};
