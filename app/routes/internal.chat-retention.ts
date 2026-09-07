import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

import { runChatRetentionPurge } from "../services/chat-retention.server";

// Chat-data retention purge — triggered nightly by the Google Cloud Scheduler
// job `delivery-scheduler-chat-retention` (Cloud Run has no native cron; same
// shared-secret pattern as internal.lalamove-poll.ts).
//
// ZERO Shopify writes and zero Admin API reads — the purge is Postgres-only
// (SupportChat* / AgentRateLimit / LookupAttempt; Messenger tables untouched).
// Sits outside the docs/api.md §2 order write-path contract by construction:
// this route never imports shopify.server at all.

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const secret = process.env.CHAT_RETENTION_SECRET?.trim();
  const provided = request.headers.get("x-chat-retention-secret")?.trim();
  if (!secret || !provided || !timingSafeEqualStrings(provided, secret)) {
    return new Response(null, { status: 401 });
  }

  try {
    const summary = await runChatRetentionPurge();
    return Response.json(summary);
  } catch (error) {
    // ADR-11 posture (consistency with the other internal routes): a failed
    // purge answers 200 + ok:false — the next nightly run retries naturally.
    console.warn(
      `[chat-retention] purge threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json({ ok: false, error: "purge failed" }, { status: 200 });
  }
};
