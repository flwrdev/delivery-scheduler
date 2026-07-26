// Facebook Messenger Send API — outbound side of the FlowerCart Messenger
// webhook (phase 2 echo bot). Plain fetch against the Graph API by design (no
// SDK wrapper). Phase 3 moves calls behind Cloud Tasks; the call shape here
// stays the same.
//
// The page access token travels ONLY in the Authorization header — never in
// the URL — so it cannot leak into request logs or error strings.

// Pinned Graph API version; cross-check against the Meta app dashboard's
// supported range when generating tokens. Never float this.
export const MESSENGER_GRAPH_API_VERSION = "v23.0";

export const MESSENGER_NOT_CONFIGURED_MESSAGE =
  "Messenger sending is not configured on this environment.";

const SEND_TIMEOUT_MS = 5000;

export interface SendMessengerTextMessageInput {
  psid: string;
  text: string;
}

export type SendMessengerTextMessageResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

export async function sendMessengerTextMessage({
  psid,
  text,
}: SendMessengerTextMessageInput): Promise<SendMessengerTextMessageResult> {
  const accessToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim();
  const pageId = process.env.MESSENGER_PAGE_ID?.trim();
  if (!accessToken || !pageId) {
    return { ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${MESSENGER_GRAPH_API_VERSION}/${pageId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: "RESPONSE",
          message: { text },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );

    let payload: { message_id?: string; error?: { message?: string } } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — fall through to the status-based error below.
    }

    if (!response.ok || payload.error) {
      const graphMessage = payload.error?.message ?? "unknown error";
      return { ok: false, error: `Graph API ${response.status}: ${graphMessage}` };
    }

    return { ok: true, messageId: payload.message_id ?? "" };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, error: "Messenger send timed out." };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to send Messenger message.",
    };
  }
}
