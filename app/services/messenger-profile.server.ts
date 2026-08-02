// Messenger Profile API — Get Started button, Ice Breakers, Persistent Menu
// (FlowerCart Messenger agent, phase 8). One-time merchant-triggered setup
// mula sa /app/messenger-orders; ang mga tap ay dumadating sa existing webhook
// postback path bilang `[TAP] <payload>` — walang webhook changes dito.
//
// Same conventions as messenger-send.server.ts: plain fetch, pinned Graph
// version, page token sa Authorization header LANG (never in the URL, never
// logged), designed { ok:false } failures — never throws.

import {
  MESSENGER_GRAPH_API_VERSION,
  MESSENGER_NOT_CONFIGURED_MESSAGE,
} from "./messenger-send.server";

const PROFILE_TIMEOUT_MS = 5000;

const PROFILE_FIELDS = "get_started,ice_breakers,persistent_menu";

// Payloads na inaasahan ng system prompt ([TAP] rules sa messenger-agent).
export const GET_STARTED_PAYLOAD = "GET_STARTED";
export const MENU_ORDER_PAYLOAD = "MENU_ORDER";

// Ang buong profile body — exported para ma-pin ng tests ang exact shape na
// ipinapadala sa Meta (at para makita sa code review kung ano ang nakikita ng
// customer, nang hindi tumitingin sa Meta dashboard).
export const MESSENGER_PROFILE_BODY = {
  get_started: { payload: GET_STARTED_PAYLOAD },
  ice_breakers: [
    {
      locale: "default",
      call_to_actions: [
        { question: "🌸 Anong flowers ang available?", payload: "ICEBREAKER_PRODUCTS" },
        { question: "🚚 Magkano ang delivery sa amin?", payload: "ICEBREAKER_FEE" },
        { question: "📅 May same-day delivery ba kayo?", payload: "ICEBREAKER_SAMEDAY" },
        { question: "🛒 Paano mag-order?", payload: "ICEBREAKER_ORDER" },
      ],
    },
  ],
  persistent_menu: [
    {
      locale: "default",
      composer_input_disabled: false,
      call_to_actions: [
        {
          type: "web_url",
          title: "Tingnan ang mga bulaklak",
          url: "https://flowercart.store/collections/all",
        },
        {
          type: "web_url",
          title: "Delivery coverage",
          url: "https://flowercart.store/pages/delivery-coverage",
        },
        {
          type: "postback",
          title: "🛒 Mag-order dito sa chat",
          payload: MENU_ORDER_PAYLOAD,
        },
      ],
    },
  ],
} as const;

export type SetMessengerProfileResult =
  | { ok: true }
  | { ok: false; error: string };

export interface MessengerProfileStatus {
  hasGetStarted: boolean;
  hasIceBreakers: boolean;
  hasPersistentMenu: boolean;
}

export type GetMessengerProfileResult =
  | { ok: true; profile: MessengerProfileStatus }
  | { ok: false; error: string };

function profileUrl(): string {
  return `https://graph.facebook.com/${MESSENGER_GRAPH_API_VERSION}/me/messenger_profile`;
}

function toFailure(error: unknown, fallback: string): { ok: false; error: string } {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { ok: false, error: "Messenger profile request timed out." };
  }
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

/** One POST sets lahat ng tatlong profile fields (idempotent sa Meta side). */
export async function setMessengerProfile(): Promise<SetMessengerProfileResult> {
  const accessToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return { ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE };
  }

  try {
    const response = await fetch(profileUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(MESSENGER_PROFILE_BODY),
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });

    let payload: { result?: string; error?: { message?: string } } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — fall through to the status-based error below.
    }

    if (!response.ok || payload.error) {
      const graphMessage = payload.error?.message ?? "unknown error";
      return { ok: false, error: `Graph API ${response.status}: ${graphMessage}` };
    }

    return { ok: true };
  } catch (error) {
    return toFailure(error, "Failed to set the Messenger profile.");
  }
}

/** Best-effort read para sa "set / not set" display sa admin page. */
export async function getMessengerProfile(): Promise<GetMessengerProfileResult> {
  const accessToken = process.env.MESSENGER_PAGE_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return { ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE };
  }

  try {
    const response = await fetch(`${profileUrl()}?fields=${PROFILE_FIELDS}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });

    let payload: {
      data?: Array<{
        get_started?: unknown;
        ice_breakers?: unknown[];
        persistent_menu?: unknown[];
      }>;
      error?: { message?: string };
    } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — fall through to the status-based error below.
    }

    if (!response.ok || payload.error) {
      const graphMessage = payload.error?.message ?? "unknown error";
      return { ok: false, error: `Graph API ${response.status}: ${graphMessage}` };
    }

    const entry = payload.data?.[0] ?? {};
    return {
      ok: true,
      profile: {
        hasGetStarted: entry.get_started != null,
        hasIceBreakers: Array.isArray(entry.ice_breakers) && entry.ice_breakers.length > 0,
        hasPersistentMenu:
          Array.isArray(entry.persistent_menu) && entry.persistent_menu.length > 0,
      },
    };
  } catch (error) {
    return toFailure(error, "Failed to read the Messenger profile.");
  }
}
