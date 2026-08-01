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

export interface MessengerQuickReply {
  title: string;
  payload: string;
}

export interface SendMessengerTextMessageInput {
  psid: string;
  text: string;
  /** Optional tap choices (phase 4+: slot selection is quick replies only). */
  quickReplies?: MessengerQuickReply[];
}

export type SendMessengerTextMessageResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/** One card in a Generic Template carousel (phase 5 product discovery). */
export interface MessengerCarouselElement {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  /** Tap on the card/picture itself opens this URL (merchant: walang button para kita ang picture). */
  defaultActionUrl?: string;
  buttons?: Array<
    | { type: "postback"; title: string; payload: string }
    | { type: "web_url"; title: string; url: string }
  >;
}

async function postMessengerMessage(
  psid: string,
  message: unknown,
): Promise<SendMessengerTextMessageResult> {
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
          message,
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

export async function sendMessengerTextMessage({
  psid,
  text,
  quickReplies,
}: SendMessengerTextMessageInput): Promise<SendMessengerTextMessageResult> {
  const message: { text: string; quick_replies?: unknown[] } = { text };
  if (quickReplies?.length) {
    message.quick_replies = quickReplies.map((reply) => ({
      content_type: "text",
      title: reply.title,
      payload: reply.payload,
    }));
  }
  return postMessengerMessage(psid, message);
}

// Messenger Generic Template hard limits: 10 elements max (we cap at 8 per the
// master doc), 80-char title/subtitle, 3 buttons per element.
const CAROUSEL_ELEMENT_LIMIT = 10;
const CAROUSEL_TEXT_LIMIT = 80;
const CAROUSEL_BUTTON_LIMIT = 3;

export async function sendMessengerGenericTemplate({
  psid,
  elements,
}: {
  psid: string;
  elements: MessengerCarouselElement[];
}): Promise<SendMessengerTextMessageResult> {
  if (!elements.length) {
    return { ok: false, error: "Generic template needs at least one element." };
  }

  const message = {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: elements.slice(0, CAROUSEL_ELEMENT_LIMIT).map((element) => ({
          title: element.title.slice(0, CAROUSEL_TEXT_LIMIT),
          ...(element.subtitle ? { subtitle: element.subtitle.slice(0, CAROUSEL_TEXT_LIMIT) } : {}),
          ...(element.imageUrl ? { image_url: element.imageUrl } : {}),
          ...(element.defaultActionUrl
            ? {
                default_action: {
                  type: "web_url",
                  url: element.defaultActionUrl,
                },
              }
            : {}),
          ...(element.buttons?.length
            ? { buttons: element.buttons.slice(0, CAROUSEL_BUTTON_LIMIT) }
            : {}),
        })),
      },
    },
  };
  return postMessengerMessage(psid, message);
}
