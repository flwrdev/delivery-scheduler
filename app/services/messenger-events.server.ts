// Neon-backed Messenger ingress recording (phases 3+): inbound dedupe.
//
// Dedupe layers (the phase-3 gate: zero duplicate replies):
//   1. Webhook: MessengerMessage.mid is unique — a Meta redelivery hits P2002
//      and is skipped before any task is enqueued.
//   2. Worker: repliedAt is set right after a successful send — a Cloud Tasks
//      retry that finds it set skips the send (see messenger-agent.server.ts,
//      which owns reply generation since phase 4).
//
// Log hygiene: mids, psids, statuses, error strings — never message text.

import prisma from "../db.server";

export interface RecordInboundTextMessageInput {
  psid: string;
  mid: string;
  text: string;
}

export type RecordInboundTextMessageResult =
  | { status: "new" }
  | { status: "duplicate" }
  | { status: "error"; error: string };

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

// Phase 7 (human takeover) — echo discriminator FALLBACK: the bot records the
// mid of every message it sends (deliverReplyAndBookkeep), so an echo whose
// mid is already in Neon was sent by us. Throws on DB failure — the webhook
// catches and skips the event (never set humanControl on a blind guess).
export async function isKnownMessageMid(mid: string): Promise<boolean> {
  const row = await prisma.messengerMessage.findUnique({
    where: { mid },
    select: { mid: true },
  });
  return row !== null;
}

// Phase 7 (human takeover): an echo the bot did NOT originate = the operator
// typing from Business Suite. Mute the bot (humanControl) and KEEP the
// operator's words in the transcript — while paused the bot still listens, so
// it is not blind to what the human discussed when it resumes.
// The thread upsert runs before the message create on purpose: a Meta
// redelivery of the same echo mid still refreshes humanControlAt (the
// auto-handback window is "N hours with no operator message").
export async function recordOperatorEchoMessage({
  psid,
  mid,
  text,
}: RecordInboundTextMessageInput): Promise<RecordInboundTextMessageResult> {
  const now = new Date();
  try {
    await prisma.messengerThread.upsert({
      where: { psid },
      create: { psid, humanControl: true, humanControlAt: now },
      update: { humanControl: true, humanControlAt: now },
    });
    await prisma.messengerMessage.create({
      data: {
        psid,
        role: "operator",
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
      error: error instanceof Error ? error.message : "Failed to record operator echo.",
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
