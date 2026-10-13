import { sendCustomerEmail } from "./send-customer-email.server";

// Customer email after a merchant reschedule, sent through sendCustomerEmail
// (same transport, From and BCC copy). The recipient comes from the order the
// bulk executor read via Admin GraphQL, never from the request.

export interface RescheduleNoticeInput {
  orderId: string;
  orderName: string | null;
  to: string | null;
  firstName: string | null;
  fromDate: string | null;
  fromTimeSlot: string | null;
  toDate: string;
  toTimeSlot: string;
}

export type RescheduleNoticeResult =
  | { status: "sent"; to: string }
  | { status: "skipped_no_email" }
  | { status: "failed"; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Mon, Sep 28, 2026" from "2026-09-28"; anything else passes through. */
export function formatNoticeDate(iso: string | null | undefined): string {
  if (!iso || !ISO_DATE_RE.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function scheduleLabel(date: string | null | undefined, slot: string | null | undefined): string {
  return [formatNoticeDate(date), slot?.trim() || ""].filter(Boolean).join(", ");
}

function brandName(): string {
  return process.env.EMAIL_FROM_NAME?.trim() || "The Flowercart";
}

export function buildRescheduleNotice(
  input: RescheduleNoticeInput,
): { subject: string; textBody: string } {
  const orderLabel = input.orderName?.trim() || "your order";
  const toLabel = scheduleLabel(input.toDate, input.toTimeSlot);
  const fromLabel = scheduleLabel(input.fromDate, input.fromTimeSlot);
  const greeting = input.firstName?.trim() ? `Hi ${input.firstName.trim()},` : "Hi there,";
  const lines = [
    greeting,
    "",
    `We've updated the delivery schedule for ${
      orderLabel === "your order" ? "your order" : `your order ${orderLabel}`
    }.`,
    "",
    `New delivery: ${toLabel}`,
  ];
  if (fromLabel && fromLabel !== toLabel) {
    lines.push(`Previous: ${fromLabel}`);
  }
  lines.push(
    "",
    "If this new schedule doesn't work for you, just reply to this email and we'll sort it out.",
    "",
    "Thank you,",
    brandName(),
  );
  return {
    subject: `Order ${orderLabel === "your order" ? "update" : orderLabel}: new delivery schedule - ${toLabel}`,
    textBody: lines.join("\n"),
  };
}

export async function sendRescheduleNotice(
  _shop: string,
  input: RescheduleNoticeInput,
): Promise<RescheduleNoticeResult> {
  const to = input.to?.trim() || "";
  if (!to) return { status: "skipped_no_email" };

  const { subject, textBody } = buildRescheduleNotice(input);
  let sent: Awaited<ReturnType<typeof sendCustomerEmail>>;
  try {
    sent = await sendCustomerEmail({ to, subject, textBody });
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to send the email.",
    };
  }
  if (!sent.ok) return { status: "failed", error: sent.error };
  return { status: "sent", to };
}
