import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  SHOPIFY_ORDER_GID_RE,
  methodNotAllowed,
  withEmailApiAuth,
} from "../email-api.server";
import { getOrderThread } from "../services/customer-inbox.server";

// Only the order id comes from the client. The order name and customer email
// are read from Shopify.
const ORDER_FOR_THREAD_QUERY = `#graphql
  query OrderForEmailThread($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer {
        defaultEmailAddress {
          emailAddress
        }
      }
    }
  }
`;

interface OrderForThread {
  id: string;
  name: string;
  email?: string | null;
  customer?: {
    defaultEmailAddress?: { emailAddress?: string | null } | null;
  } | null;
}

// GET /api/email/thread?orderId=: every email for one order, newest first.
export const loader = ({ request }: LoaderFunctionArgs) =>
  withEmailApiAuth(request, async ({ admin }) => {
    const orderId = new URL(request.url).searchParams.get("orderId")?.trim() ?? "";
    const failure = (error: string, status?: number) =>
      Response.json({ ok: false, error }, status ? { status } : undefined);

    if (!SHOPIFY_ORDER_GID_RE.test(orderId)) {
      return failure("Invalid order ID.", 400);
    }

    let order: OrderForThread | null;
    try {
      const res = await admin.graphql(ORDER_FOR_THREAD_QUERY, { variables: { id: orderId } });
      const body = (await res.json()) as {
        data?: { order?: OrderForThread | null };
        errors?: Array<{ message: string }>;
      };
      if (body.errors?.length) {
        return failure(`Couldn't read the order: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      order = body.data?.order ?? null;
    } catch (e) {
      return failure(e instanceof Error ? e.message : "Couldn't read the order.");
    }
    if (!order) {
      return failure("Order not found.", 404);
    }

    const result = await getOrderThread({
      orderName: order.name,
      customerEmail: order.customer?.defaultEmailAddress?.emailAddress ?? order.email ?? null,
    });
    if (!result.ok) {
      console.warn(`[api/email/thread] ${order.name}: ${result.error}`);
    }
    return Response.json(result);
  });

// Answers the CORS preflight; any other method is rejected.
export const action = ({ request }: ActionFunctionArgs) =>
  withEmailApiAuth(request, async () => methodNotAllowed());
