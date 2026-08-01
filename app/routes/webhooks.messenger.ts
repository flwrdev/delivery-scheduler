import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { verifyMetaWebhookSignature } from "../lib/verify-meta-signature.server";
import { sendMessengerTextMessage } from "../services/messenger-send.server";

// Facebook Messenger webhook (FlowerCart Messenger agent, phase 2 echo bot).
//
// This is the app's FIFTH auth surface: Meta signs every POST with
// X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app secret) — it does NOT
// go through authenticate.webhook and is NOT registered in shopify.app.toml.
//
// Contract with Meta: after the signature verifies, ALWAYS return 200 — Meta
// redelivers on non-200 and disables the webhook after repeated failures.
// Send failures are logged, never surfaced as 5xx.
//
// Phase 2 deviation (recorded in PROGRESS.md): the echo send is awaited inline
// BEFORE the 200. Cloud Run throttles CPU once the response returns, so
// fire-and-forget work dies mid-flight; the real fast-ack + enqueue shape
// arrives in phase 3 with Cloud Tasks.
//
// Log hygiene: log event counts, mids, and error strings — never message text
// or full payloads.

// Messenger rejects text messages longer than 2000 chars.
const MESSENGER_TEXT_LIMIT = 2000;

interface MessengerWebhookEvent {
  sender?: { id?: string };
  message?: {
    mid?: string;
    text?: unknown;
    is_echo?: boolean;
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
      const message = event.message;
      // is_echo is the loop guard: message_echoes is a subscribed field, so
      // without this skip the bot would echo its own echoes forever.
      if (!message || message.is_echo || typeof message.text !== "string" || !message.text) {
        continue;
      }

      const psid = event.sender?.id;
      if (!psid) {
        console.warn("[messenger] text message event without sender.id — skipped");
        continue;
      }

      const echoText = `Echo: ${message.text}`.slice(0, MESSENGER_TEXT_LIMIT);
      try {
        const result = await sendMessengerTextMessage({ psid, text: echoText });
        if (result.ok) {
          console.log(`[messenger] echoed mid=${message.mid ?? "?"} reply=${result.messageId}`);
        } else {
          console.warn(`[messenger] echo send failed: ${result.error}`);
        }
      } catch (error) {
        console.warn(
          `[messenger] echo send threw: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
  }

  return new Response(null, { status: 200 });
};
