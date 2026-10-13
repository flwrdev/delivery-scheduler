import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { AdminGraphQLClient } from "./order-delivery-metafields.server";
import { isValidMessageId } from "../lib/email-replies";

// Plain-text customer email sent over SMTP from the merchant's Private Email
// mailbox. Nothing is written to the Shopify order or to a database.

export const MAX_EMAIL_SUBJECT_LENGTH = 200;
export const MAX_EMAIL_BODY_LENGTH = 5000;

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email sending is not configured on this environment.";

export interface SendCustomerEmailInput {
  to: string;
  subject: string;
  textBody: string;
  /** Without In-Reply-To/References the customer's client files the reply as a new conversation. */
  inReplyTo?: string;
}

export type SendCustomerEmailResult =
  | { ok: true }
  | { ok: false; error: string };

// Response body of the `sendEmail` op.
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

// One transport per process, reused across sends.
let cachedTransport: Transporter | null = null;

export function _resetEmailTransportForTests(): void {
  cachedTransport = null;
}

function getTransport(cfg: SmtpConfig): Transporter {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 465 = implicit SSL; 587 uses STARTTLS (secure: false).
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.password },
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
    // response codes; the server's own wording is passed through.
    return `The mail server rejected the message${message ? `: ${message}` : "."}`;
  }
  return message || "Failed to send the email.";
}

// One SMTP send per email. The BCC to the sending mailbox is the merchant's
// copy, because Private Email SMTP sends do not land in the webmail Sent folder.
export async function sendCustomerEmail({
  to,
  subject,
  textBody,
  inReplyTo,
}: SendCustomerEmailInput): Promise<SendCustomerEmailResult> {
  const cfg = smtpConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: EMAIL_NOT_CONFIGURED_MESSAGE };
  }
  const from = cfg.fromName
    ? { name: cfg.fromName, address: cfg.user }
    : cfg.user;
  const threading = inReplyTo ? { inReplyTo, references: [inReplyTo] } : {};
  try {
    await getTransport(cfg).sendMail({
      from,
      to,
      bcc: cfg.user,
      subject,
      text: textBody,
      ...threading,
    });
  } catch (e: unknown) {
    return { ok: false, error: humanizeSmtpError(e) };
  }
  return { ok: true };
}

// ─── The `sendEmail` op ─────────────────────────────────────────────────────

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

// Validation errors are 4xx; order-read and SMTP failures are 200 + ok:false.
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
  const inReplyTo = String(fd.get("inReplyTo") || "").trim();

  if (!SHOPIFY_ORDER_GID_RE.test(orderId)) {
    return opJson({ ok: false, message: "Invalid order ID." }, 400);
  }
  if (inReplyTo && !isValidMessageId(inReplyTo)) {
    return opJson({ ok: false, message: "Invalid reply reference." }, 400);
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

  // The recipient is read from the order, never taken from the request.
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

  const sent = await sendCustomerEmail({
    to: email,
    subject,
    textBody: body,
    ...(inReplyTo ? { inReplyTo } : {}),
  });
  if (!sent.ok) {
    return opJson({ ok: false, message: sent.error });
  }
  return opJson({ ok: true, message: `Email sent to ${email}.` });
}
