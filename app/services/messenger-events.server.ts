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
