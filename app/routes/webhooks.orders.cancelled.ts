import { authenticate, unauthenticated } from "../shopify.server";
import { cancelLalamoveOrder } from "../lib/lalamove.server";

const GET_LALAMOVE_ORDER_ID_QUERY = `
  query GetLalamoveOrderId($id: ID!) {
    order(id: $id) {
      lalamoveOrderId: metafield(namespace: "lalamove", key: "order_id") { value }
      lalamoveStatus: metafield(namespace: "lalamove", key: "status") { value }
    }
  }
`;

const SET_LALAMOVE_STATUS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;

  const numericId = orderPayload.id;
  if (!numericId) return new Response(null, { status: 200 });

  const shopifyOrderGid = `gid://shopify/Order/${numericId}`;

  const { admin } = await unauthenticated.admin(shop);

  const metaRes = await admin.graphql(GET_LALAMOVE_ORDER_ID_QUERY, {
    variables: { id: shopifyOrderGid },
  });
  const metaBody = (await metaRes.json()) as {
    data?: {
      order?: {
        lalamoveOrderId?: { value: string } | null;
        lalamoveStatus?: { value: string } | null;
      };
    };
  };

  const lalamoveOrderId = metaBody.data?.order?.lalamoveOrderId?.value;
  const lalamoveStatus = metaBody.data?.order?.lalamoveStatus?.value;

  if (!lalamoveOrderId) {
    console.log("[orders/cancelled] No Lalamove order — skipping.");
    return new Response(null, { status: 200 });
  }

  const cancellableStatuses = ["ASSIGNING_DRIVER", "ON_GOING"];
  if (!cancellableStatuses.includes(lalamoveStatus ?? "")) {
    console.log(
      `[orders/cancelled] Lalamove status ${lalamoveStatus} — cannot cancel. Skipping.`,
    );
    return new Response(null, { status: 200 });
  }

  try {
    await cancelLalamoveOrder(lalamoveOrderId);
    console.log(`[orders/cancelled] Cancelled Lalamove order ${lalamoveOrderId}`);
  } catch (e) {
    console.warn(
      `[orders/cancelled] Cancel failed for Lalamove order ${lalamoveOrderId}:`,
      e,
    );
  }

  await admin.graphql(SET_LALAMOVE_STATUS_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: shopifyOrderGid,
          namespace: "lalamove",
          key: "status",
          value: "CANCELED",
          type: "single_line_text_field",
        },
      ],
    },
  });

  return new Response(null, { status: 200 });
};
