import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { AdminGraphQLClient } from "./order-delivery-metafields.server";

// Customer Email (customer-email-design.md): in-app compose, sent server-side
// through the merchant's business mailbox on Namecheap Private Email via
// plain SMTP AUTH (E-1). Written reusable beyond the orders panel — the
// planned Communications page calls the same entry points (E-2). Sending
// writes NOTHING to the Shopify order (E-5): this module is an outbound side
// effect only.

export const MAX_EMAIL_SUBJECT_LENGTH = 200;
export const MAX_EMAIL_BODY_LENGTH = 5000;

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email sending is not configured on this environment.";

export interface SendCustomerEmailInput {
  to: string;
  subject: string;
  textBody: string;
}

export type SendCustomerEmailResult =
  | { ok: true }
  | { ok: false; error: string };

// Response shape of the `sendEmail` op (app.orders.tsx action) — read by the
// SendEmailModal fetcher.
export interface SendEmailResponse {
  ok: boolean;
  message: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
}

function smtpConfig(): SmtpConfig {
  return {
    host: process.env.EMAIL_SMTP_HOST?.trim() || "mail.privateemail.com",
    port: Number(process.env.EMAIL_SMTP_PORT?.trim() || "465"),
    user: process.env.EMAIL_SMTP_USER?.trim() || "",
    password: process.env.EMAIL_SMTP_PASSWORD || "",
    fromName: process.env.EMAIL_FROM_NAME?.trim() || "",
  };
}

// Module-level lazy singleton — Cloud Run instances are reused; do not
// rebuild the connection pool per send.
let cachedTransport: Transporter | null = null;

export function _resetEmailTransportForTests(): void {
  cachedTransport = null;
}

function getTransport(cfg: SmtpConfig): Transporter {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 465 = implicit SSL; the 587 fallback uses STARTTLS (secure: false).
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.password },
      // §5: credentials and message content never reach the logs.
      logger: false,
    });
  }
  return cachedTransport;
}

function humanizeSmtpError(e: unknown): string {
  const err = e as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const responseCode =
    typeof err?.responseCode === "number" ? err.responseCode : null;
  const message = typeof err?.message === "string" ? err.message : "";
  if (code === "EAUTH") {
    return "The mail server rejected the sign-in — check the SMTP email/password configuration.";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNECTION" ||
    code === "EDNS"
  ) {
    return "Couldn't reach the mail server. Try again in a moment.";
  }
  if (responseCode !== null && responseCode >= 400) {
    // Provider rejections (e.g. the hourly sending limit) arrive as SMTP
    // response codes — surface the server's own wording.
    return `The mail server rejected the message${message ? `: ${message}` : "."}`;
  }
  return message || "Failed to send the email.";
}

export async function sendCustomerEmail({
  to,
  subject,
  textBody,
}: SendCustomerEmailInput): Promise<SendCustomerEmailResult> {
  const cfg = smtpConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: EMAIL_NOT_CONFIGURED_MESSAGE };
  }
  try {
    await getTransport(cfg).sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: cfg.user } : cfg.user,
      to,
      // E-3: every send BCCs the sender mailbox — Private Email SMTP sends do
      // not land in the webmail Sent folder, so this is the merchant's copy.
      bcc: cfg.user,
      subject,
      text: textBody,
    });
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: humanizeSmtpError(e) };
  }
}

// ─── The `sendEmail` op (dispatched from the app.orders.tsx action) ─────────

const ORDER_CUSTOMER_EMAIL_QUERY = `#graphql
  query OrderCustomerEmailForSend($id: ID!) {
    order(id: $id) {
      id
      customer {
        defaultEmailAddress {
          emailAddress
        }
      }
    }
  }
`;

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

// Upstream failures (order read, SMTP send) return 200 + ok:false, NOT 5xx:
// Cloudflare replaces origin 502/504 bodies with its branded HTML error page
// (observed live through the dev tunnel 2026-07-13), which breaks the
// fetcher's JSON contract and blows up the embedded iframe. Same shape as the
// bulk ops, which also report failures inside a 200 payload. Validation stays
// 4xx — Cloudflare passes those through untouched.
function opJson(payload: SendEmailResponse, status = 200): Response {
  return Response.json(payload, status === 200 ? undefined : { status });
}

export async function handleSendEmailOp(
  admin: AdminGraphQLClient,
  fd: FormData,
): Promise<Response> {
  const orderId = String(fd.get("orderId") || "");
  const subject = String(fd.get("subject") || "").trim();
  const body = String(fd.get("body") || "").trim();

  if (!SHOPIFY_ORDER_GID_RE.test(orderId)) {
    return opJson({ ok: false, message: "Invalid order ID." }, 400);
  }
  if (!subject) {
    return opJson({ ok: false, message: "Enter a subject." }, 400);
  }
  if (subject.length > MAX_EMAIL_SUBJECT_LENGTH) {
    return opJson(
      {
        ok: false,
        message: `Subject must be ${MAX_EMAIL_SUBJECT_LENGTH} characters or fewer.`,
      },
      400,
    );
  }
  if (!body) {
    return opJson({ ok: false, message: "Enter a message." }, 400);
  }
  if (body.length > MAX_EMAIL_BODY_LENGTH) {
    return opJson(
      {
        ok: false,
        message: `Message must be ${MAX_EMAIL_BODY_LENGTH} characters or fewer.`,
      },
      400,
    );
  }

  // E-4: the recipient is NEVER client-supplied — re-read the customer email
  // from the order, so the op cannot be used as an arbitrary-recipient relay.
  let email: string | null = null;
  try {
    const res = await admin.graphql(ORDER_CUSTOMER_EMAIL_QUERY, {
      variables: { id: orderId },
    });
    const j = (await res.json()) as {
      data?: {
        order?: {
          customer?: {
            defaultEmailAddress?: { emailAddress?: string | null } | null;
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) {
      return opJson({
        ok: false,
        message: `Couldn't read the order: ${j.errors.map((e) => e.message).join("; ")}`,
      });
    }
    if (!j.data?.order) {
      return opJson({ ok: false, message: "Order not found." }, 404);
    }
    email =
      j.data.order.customer?.defaultEmailAddress?.emailAddress?.trim() || null;
  } catch (e: unknown) {
    return opJson({
      ok: false,
      message: e instanceof Error ? e.message : "Couldn't read the order.",
    });
  }
  if (!email) {
    return opJson(
      { ok: false, message: "This order has no customer email." },
      400,
    );
  }

  const sent = await sendCustomerEmail({ to: email, subject, textBody: body });
  if (!sent.ok) {
    return opJson({ ok: false, message: sent.error });
  }
  return opJson({ ok: true, message: `Email sent to ${email}.` });
}
