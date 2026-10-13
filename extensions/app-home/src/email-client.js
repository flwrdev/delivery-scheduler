import { EMAIL_REPLY_SEEN_OP, handleMarkSeenOp } from "../../../app/services/reschedule-seen.server";
import { adminClient } from "./admin-client";

// Calls to the email server. Relative URLs resolve against the app's
// application_url, and Shopify adds the ID token as the Authorization header.

const UNREACHABLE = "Couldn't reach the email server.";

async function call(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    return null;
  }
  try {
    const body = await response.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function postJson(path, payload) {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Unseen customer replies matched to orders: {ok, data} or {ok:false, error}. */
export async function loadEmailReplies() {
  return (await call("/api/email/replies")) ?? { ok: false, error: UNREACHABLE };
}

/** Emails for one order, newest first: {ok, data} or {ok:false, error}. */
export async function loadOrderThread(orderId) {
  const qs = new URLSearchParams({ orderId }).toString();
  return (await call(`/api/email/thread?${qs}`)) ?? { ok: false, error: UNREACHABLE };
}

/** Sends a plain-text email to the order's customer: {ok, message}. */
export async function sendOrderEmail({ orderId, subject, body, inReplyTo }) {
  return (
    (await postJson("/api/email/send", {
      orderId,
      subject,
      body,
      ...(inReplyTo ? { inReplyTo } : {}),
    })) ?? { ok: false, message: UNREACHABLE }
  );
}

/** Marks replies seen on the order metafield $app.email_reply_seen_at: {ok, message}. */
export async function markRepliesSeen(items) {
  const fd = new FormData();
  for (const item of items) {
    fd.append("orderId", item.orderId);
    fd.append("receivedAt", item.receivedAt);
  }
  const response = await handleMarkSeenOp(adminClient, fd, EMAIL_REPLY_SEEN_OP);
  return response.json();
}

/** Customer email after a merchant reschedule. Resolves to a RescheduleNoticeResult. */
export async function sendRescheduleNotice(_shop, input) {
  if (!input.to?.trim()) return { status: "skipped_no_email" };
  const result = await postJson("/api/email/reschedule-notice", input);
  if (!result) return { status: "failed", error: UNREACHABLE };
  return result;
}
