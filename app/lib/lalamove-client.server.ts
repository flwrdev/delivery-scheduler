import crypto from "node:crypto";

// Thin client for the Lalamove Open API (v3) — status-listen only (ADR-16).
// This app NEVER calls the order-creation/edit/cancel endpoints; the merchant
// keeps booking every delivery by hand on web.lalamove.com. The only calls
// made here are read-only order-status lookups and the one-time webhook
// registration.
//
// Auth: HMAC-SHA256 per Lalamove's v3 spec —
//   SIGNATURE = HmacSHA256Hex(`${TIMESTAMP}\r\n${METHOD}\r\n${PATH}\r\n\r\n${BODY}`, API_SECRET)
//   Authorization: hmac <API_KEY>:<TIMESTAMP>:<SIGNATURE>
// Confirmed live against the production API this session (2026-08-16):
// getOrderStatus resolves via the "#" order id shown in the Lalamove web
// Records list — NOT via the token embedded in a share.lalamove.com tracking
// link, which is a separate, unrelated share code.

const SANDBOX_BASE_URL = "https://rest.sandbox.lalamove.com";
const PRODUCTION_BASE_URL = "https://rest.lalamove.com";

function getBaseUrl(): string {
  return process.env.LALAMOVE_ENV === "sandbox"
    ? SANDBOX_BASE_URL
    : PRODUCTION_BASE_URL;
}

export interface LalamoveCredentials {
  apiKey: string;
  apiSecret: string;
  market: string;
}

export function getLalamoveCredentials(): LalamoveCredentials | null {
  const apiKey = process.env.LALAMOVE_API_KEY?.trim();
  const apiSecret = process.env.LALAMOVE_API_SECRET?.trim();
  const market = process.env.LALAMOVE_MARKET?.trim() || "PH";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret, market };
}

function sign(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  apiSecret: string,
): string {
  const raw = `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${body}`;
  return crypto.createHmac("sha256", apiSecret).update(raw).digest("hex");
}

async function lalamoveRequest(
  method: "GET" | "PATCH",
  path: string,
  credentials: LalamoveCredentials,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = sign(method, path, bodyText, timestamp, credentials.apiSecret);
  const authorization = `hmac ${credentials.apiKey}:${timestamp}:${signature}`;

  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: authorization,
      Market: credentials.market,
      "Content-Type": "application/json",
    },
    body: bodyText || undefined,
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export interface LalamoveOrderStop {
  address?: string;
  name?: string;
  phone?: string;
  POD?: { status?: string; deliveredAt?: string };
}

export interface LalamoveOrderStatus {
  orderId: string;
  status: string; // ASSIGNING_DRIVER | ON_GOING | PICKED_UP | COMPLETED | CANCELED | REJECTED | EXPIRED
  shareLink?: string;
  stops?: LalamoveOrderStop[];
}

export type GetOrderStatusResult =
  | { ok: true; order: LalamoveOrderStatus }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; error: string };

// GET /v3/orders/{orderId} — the orderId MUST be the numeric id Lalamove
// itself assigned (visible as "#<id>" in the web Records list), never a
// share-link token.
export async function getOrderStatus(
  orderId: string,
): Promise<GetOrderStatusResult> {
  const credentials = getLalamoveCredentials();
  if (!credentials) {
    return { ok: false, notFound: false, error: "LALAMOVE_API_KEY/SECRET not configured" };
  }

  try {
    const { status, json } = await lalamoveRequest(
      "GET",
      `/v3/orders/${orderId}`,
      credentials,
    );
    if (status === 404) return { ok: false, notFound: true };
    const body = json as { data?: LalamoveOrderStatus; errors?: Array<{ message?: string }> };
    if (status < 200 || status >= 300 || !body?.data) {
      const message = body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${status}`;
      return { ok: false, notFound: false, error: message };
    }
    return { ok: true, order: body.data };
  } catch (error) {
    return {
      ok: false,
      notFound: false,
      error: error instanceof Error ? error.message : "network error",
    };
  }
}

// PATCH /v3/webhook — one-time setup call to point Lalamove's webhook at this
// app. Not wired to any UI; run manually (e.g. via a scratch script) once per
// environment when LALAMOVE_WEBHOOK_URL changes.
export async function configureLalamoveWebhook(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const credentials = getLalamoveCredentials();
  if (!credentials) return { ok: false, error: "LALAMOVE_API_KEY/SECRET not configured" };

  try {
    const { status, json } = await lalamoveRequest("PATCH", "/v3/webhook", credentials, { url });
    if (status < 200 || status >= 300) {
      const body = json as { errors?: Array<{ message?: string }> };
      return {
        ok: false,
        error: body?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network error" };
  }
}
