// Neon-backed Messenger event handling (phase 3): inbound dedupe + idempotent
// echo processing. Neon holds the CONVERSATION, never the order.
//
// Dedupe layers (the phase-3 gate: zero duplicate replies):
//   1. Webhook: MessengerMessage.mid is unique — a Meta redelivery hits P2002
//      and is skipped before any task is enqueued.
//   2. Worker: repliedAt is set right after a successful send — a Cloud Tasks
//      retry that finds it set skips the send.
//
// Log hygiene: mids, psids, statuses, error strings — never message text.

import prisma from "../db.server";
import {
  MESSENGER_NOT_CONFIGURED_MESSAGE,
  sendMessengerTextMessage,
} from "./messenger-send.server";

// Messenger rejects text messages longer than 2000 chars.
const MESSENGER_TEXT_LIMIT = 2000;

export interface RecordInboundTextMessageInput {
  psid: string;
  mid: string;
  text: string;
}

export type RecordInboundTextMessageResult =
  | { status: "new" }
  | { status: "duplicate" }
  | { status: "error"; error: string };

export type ProcessEchoResult =
  | { status: "sent"; replyMid: string }
  | { status: "skipped" }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "retryable_failure"; error: string };

export async function recordInboundTextMessage({
  psid,
  mid,
  text,
}: RecordInboundTextMessageInput): Promise<RecordInboundTextMessageResult> {
  const now = new Date();
  try {
    await prisma.messengerThread.upsert({
      where: { psid },
      create: { psid, lastCustomerAt: now },
      update: { lastCustomerAt: now },
    });
    await prisma.messengerMessage.create({
      data: {
        psid,
        role: "customer",
        bodyJson: JSON.stringify({ text }),
        mid,
      },
    });
    return { status: "new" };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return { status: "duplicate" };
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Failed to record Messenger message.",
    };
  }
}

// Undo a webhook-side record when its task could not be enqueued, so the Meta
// redelivery of the same mid is not swallowed by the dedupe with no task ever
// queued for it.
export async function deleteRecordedMessage(mid: string): Promise<void> {
  try {
    await prisma.messengerMessage.delete({ where: { mid } });
  } catch (error) {
    console.warn(
      `[messenger] failed to delete recorded mid=${mid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
}

export async function processEchoByMid(mid: string): Promise<ProcessEchoResult> {
  const message = await prisma.messengerMessage.findUnique({ where: { mid } });
  if (!message) {
    return { status: "not_found" };
  }
  if (message.role !== "customer" || message.repliedAt) {
    return { status: "skipped" };
  }

  let text = "";
  try {
    text = String((JSON.parse(message.bodyJson) as { text?: unknown }).text ?? "");
  } catch {
    // Unparseable body — nothing sane to echo; treat as handled.
    return { status: "skipped" };
  }

  const echoText = `Echo: ${text}`.slice(0, MESSENGER_TEXT_LIMIT);
  let sendResult: Awaited<ReturnType<typeof sendMessengerTextMessage>>;
  try {
    sendResult = await sendMessengerTextMessage({ psid: message.psid, text: echoText });
  } catch (error) {
    return {
      status: "retryable_failure",
      error: error instanceof Error ? error.message : "Messenger send threw.",
    };
  }

  if (!sendResult.ok) {
    if (sendResult.error === MESSENGER_NOT_CONFIGURED_MESSAGE) {
      return { status: "not_configured" };
    }
    return { status: "retryable_failure", error: sendResult.error };
  }

  // The reply is out — from here on this attempt MUST report success, or a
  // Cloud Tasks retry would send a duplicate. Bookkeeping failures are logged,
  // never surfaced as retryable.
  try {
    await prisma.messengerMessage.update({
      where: { mid },
      data: { repliedAt: new Date(), replyMid: sendResult.messageId },
    });
    // Record the bot-sent mid (phase 7 human-takeover echo-matching needs it).
    await prisma.messengerMessage.create({
      data: {
        psid: message.psid,
        role: "bot",
        bodyJson: JSON.stringify({ text: echoText }),
        mid: sendResult.messageId,
      },
    });
  } catch (error) {
    console.warn(
      `[messenger] reply bookkeeping failed for mid=${mid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  return { status: "sent", replyMid: sendResult.messageId };
}
