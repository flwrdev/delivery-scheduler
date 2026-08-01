import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { processAgentTurnByMid } from "../services/messenger-agent.server";
import {
  deleteRecordedMessage,
  recordInboundTextMessage,
} from "../services/messenger-events.server";
import { enqueueMessengerEchoTask } from "../services/messenger-queue.server";

// Facebook Messenger webhook (FlowerCart Messenger agent, phase 3: fast-ack
// ingress — verify, dedupe, enqueue).
//
// This is the app's FIFTH auth surface: Meta signs every POST with
// X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app secret) — it does NOT
// go through authenticate.webhook and is NOT registered in shopify.app.toml.
//
// Contract with Meta: after the signature verifies, ALWAYS return 200 — Meta
// redelivers on non-200 and disables the webhook after repeated failures.
//
// Per text event: record in Neon (MessengerMessage.mid unique = redelivery
// dedupe) → enqueue a Cloud Tasks task → 200. The worker route does the send.
// If the queue is not configured (local dev), processing runs inline instead.
// If the enqueue itself fails, the recorded row is deleted so the Meta
// redelivery of the same mid is not swallowed with no task ever queued.
//
// Log hygiene: log event counts, mids, and error strings — never message text
// or full payloads.

interface MessengerWebhookEvent {
  sender?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: unknown;
    is_echo?: boolean;
    // Phase 6: quick-reply taps (slot buttons, order Confirm) arrive as a
    // normal message whose text is the button TITLE; the machine-readable
    // payload rides in quick_reply.payload.
    quick_reply?: {
      payload?: unknown;
    };
  };
  // Phase 5: carousel button taps (messaging_postbacks). Postbacks carry no
  // mid — a synthetic pb:<psid>:<timestamp> key gives them the same dedupe.
  postback?: {
    title?: string;
    payload?: string;
    mid?: string;
  };
}

interface MessengerWebhookBody {
  object?: string;
  entry?: Array<{ messaging?: MessengerWebhookEvent[]; standby?: unknown[] }>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const verifyToken = process.env.MESSENGER_VERIFY_TOKEN?.trim();
  if (!verifyToken) {
    console.error("[messenger] MESSENGER_VERIFY_TOKEN not configured");
    return new Response(null, { status: 403 });
  }

  if (mode === "subscribe" && token === verifyToken && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(null, { status: 403 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // Raw body FIRST — the signature covers the exact bytes Meta sent.
  const rawBody = await request.text();

  const appSecret = process.env.MESSENGER_APP_SECRET?.trim();
  if (!appSecret) {
    console.error("[messenger] MESSENGER_APP_SECRET not configured");
    return new Response(null, { status: 401 });
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
    console.warn("[messenger] rejected POST with missing/invalid signature");
    return new Response(null, { status: 401 });
  }

  let body: MessengerWebhookBody;
  try {
    body = JSON.parse(rawBody) as MessengerWebhookBody;
  } catch {
    // Valid signature but unparseable body — redelivery cannot fix it.
    console.error("[messenger] malformed JSON body on a validly signed POST");
    return new Response(null, { status: 200 });
  }

  if (body.object !== "page") {
    return new Response(null, { status: 200 });
  }

  // entry[].standby (subscribed but log-only in v1) is deliberately ignored.
  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const psid = event.sender?.id;
      if (!psid) {
        console.warn("[messenger] event without sender.id — skipped");
        continue;
      }

      let mid: string;
      let text: string;
      const message = event.message;
      const quickReplyPayload =
        message && !message.is_echo && typeof message.quick_reply?.payload === "string"
          ? message.quick_reply.payload
          : "";
      if (message && quickReplyPayload) {
        // Quick-reply tap: record the machine payload, never the button title
        // (the payload is what the deterministic paths key on, e.g.
        // CONFIRM_ORDER_<key>). Same [TAP] cue as postbacks.
        if (typeof message.mid !== "string" || !message.mid) {
          console.warn("[messenger] quick-reply event without mid — skipped");
          continue;
        }
        mid = message.mid;
        text = `[TAP] ${quickReplyPayload}`;
      } else if (message && !message.is_echo && typeof message.text === "string" && message.text) {
        if (typeof message.mid !== "string" || !message.mid) {
          console.warn("[messenger] text message event without mid — skipped");
          continue;
        }
        mid = message.mid;
        text = message.text;
      } else if (event.postback?.payload) {
        // Carousel/button tap. The [TAP] prefix is the agent's cue that this is
        // a button payload, not typed text (e.g. PRODUCT_<variantId>).
        mid = event.postback.mid ?? `pb:${psid}:${event.timestamp ?? "0"}`;
        text = `[TAP] ${event.postback.payload}`;
      } else {
        // is_echo is the loop guard: message_echoes is a subscribed field, so
        // without this skip the bot would echo its own echoes forever.
        continue;
      }

      try {
        const recorded = await recordInboundTextMessage({ psid, mid, text });
        if (recorded.status === "duplicate") {
          console.log(`[messenger] duplicate mid=${mid} — skipped (redelivery dedupe)`);
          continue;
        }
        if (recorded.status === "error") {
          // Not recorded — leave it to Meta's redelivery.
          console.warn(`[messenger] record failed for mid=${mid}: ${recorded.error}`);
          continue;
        }

        const enqueued = await enqueueMessengerEchoTask({ mid });
        if (enqueued.ok) {
          console.log(`[messenger] enqueued mid=${mid}`);
        } else if (enqueued.notConfigured) {
          // Local dev fallback — no queue, process inline.
          const result = await processAgentTurnByMid(mid);
          console.log(`[messenger] inline processed mid=${mid} status=${result.status}`);
        } else {
          console.warn(`[messenger] enqueue failed for mid=${mid}: ${enqueued.error}`);
          await deleteRecordedMessage(mid);
        }
      } catch (error) {
        console.warn(
          `[messenger] event handling threw for mid=${mid}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
  }

  return new Response(null, { status: 200 });
};
