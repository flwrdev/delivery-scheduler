import type { ActionFunctionArgs } from "react-router";

import {
  SHOPIFY_ORDER_GID_RE,
  methodNotAllowed,
  readJsonObject,
  stringField,
  withEmailApiAuth,
} from "../email-api.server";
import { sendRescheduleNotice } from "../services/reschedule-notice.server";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLOT_LENGTH = 100;

// The recipient, name and order number are read from Shopify; only the order
// id and the schedule come from the client.
const ORDER_FOR_NOTICE_QUERY = `#graphql
  query OrderForRescheduleNotice($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer {
        firstName
        defaultEmailAddress {
          emailAddress
        }
      }
    }
  }
`;

interface OrderForNotice {
  id: string;
  name: string;
  email?: string | null;
  customer?: {
    firstName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null } | null;
  } | null;
}

// POST /api/email/reschedule-notice {orderId, fromDate?, fromTimeSlot?,
// toDate, toTimeSlot}: tells the customer about a merchant reschedule.
// Responds with a RescheduleNoticeResult.
export const action = ({ request }: ActionFunctionArgs) =>
  withEmailApiAuth(request, async ({ admin, session }) => {
    if (request.method !== "POST") return methodNotAllowed();
    const failed = (error: string, status = 400) =>
      Response.json({ status: "failed", error }, { status });

    const body = await readJsonObject(request);
    if (!body) return failed("Invalid request body.");

    const orderId = stringField(body, "orderId");
    const toDate = stringField(body, "toDate");
    const toTimeSlot = stringField(body, "toTimeSlot");
    const fromDate = stringField(body, "fromDate");
    const fromTimeSlot = stringField(body, "fromTimeSlot");
    if (!SHOPIFY_ORDER_GID_RE.test(orderId)) return failed("Invalid order ID.");
    if (!ISO_DATE_RE.test(toDate) || (fromDate && !ISO_DATE_RE.test(fromDate))) {
      return failed("Invalid date.");
    }
    if (!toTimeSlot || toTimeSlot.length > MAX_SLOT_LENGTH || fromTimeSlot.length > MAX_SLOT_LENGTH) {
      return failed("Invalid time slot.");
    }

    let order: OrderForNotice | null;
    try {
      const res = await admin.graphql(ORDER_FOR_NOTICE_QUERY, { variables: { id: orderId } });
      const json = (await res.json()) as {
        data?: { order?: OrderForNotice | null };
        errors?: Array<{ message: string }>;
      };
      if (json.errors?.length) {
        return failed(`Couldn't read the order: ${json.errors.map((e) => e.message).join("; ")}`, 200);
      }
      order = json.data?.order ?? null;
    } catch (e) {
      return failed(e instanceof Error ? e.message : "Couldn't read the order.", 200);
    }
    if (!order) return failed("Order not found.", 404);

    const result = await sendRescheduleNotice(session.shop, {
      orderId,
      orderName: order.name,
      to: order.customer?.defaultEmailAddress?.emailAddress?.trim() || order.email?.trim() || null,
      firstName: order.customer?.firstName ?? null,
      fromDate: fromDate || null,
      fromTimeSlot: fromTimeSlot || null,
      toDate,
      toTimeSlot,
    });
    return Response.json(result);
  });

export const loader = () => methodNotAllowed();
