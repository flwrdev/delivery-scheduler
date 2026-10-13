import type { ActionFunctionArgs } from "react-router";

import {
  methodNotAllowed,
  readJsonObject,
  stringField,
  withEmailApiAuth,
} from "../email-api.server";
import { handleSendEmailOp } from "../services/send-customer-email.server";

// POST /api/email/send {orderId, subject, body, inReplyTo?}: plain-text email
// to the order's customer. The recipient is read from the order.
export const action = ({ request }: ActionFunctionArgs) =>
  withEmailApiAuth(request, async ({ admin }) => {
    if (request.method !== "POST") return methodNotAllowed();
    const body = await readJsonObject(request);
    if (!body) {
      return Response.json({ ok: false, message: "Invalid request body." }, { status: 400 });
    }
    const fd = new FormData();
    for (const key of ["orderId", "subject", "body", "inReplyTo"]) {
      fd.set(key, stringField(body, key));
    }
    return handleSendEmailOp(admin, fd);
  });

export const loader = () => methodNotAllowed();
