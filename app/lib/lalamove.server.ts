// app/lib/lalamove.server.ts
import crypto from "node:crypto";
import { parseTimeWindowHour } from "./order-utils";

// ─── Config ──────────────────────────────────────────────────────────────────

function getLalamoveConfig() {
  const isProd = process.env.lalamove_environment === "production";
  return {
    apiKey: isProd ? process.env.lalamove_api_key! : process.env.api_key!,
    apiSecret: isProd
      ? process.env.lalamove_api_secret!
      : process.env.api_secret!,
    baseUrl: isProd
      ? "https://rest.lalamove.com"
      : "https://rest.sandbox.lalamove.com",
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function buildAuthHeader(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
  body: string,
): string {
  const time = Date.now().toString();
  const rawSignature = `${time}\r\n${method.toUpperCase()}\r\n${path}\r\n\r\n${body}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(rawSignature)
    .digest("hex");
  return `hmac ${apiKey}:${time}:${signature}`;
}

// ─── Error Parsing ────────────────────────────────────────────────────────────

export function parseLalamoveError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ id: string; detail?: string; message?: string }>;
    };
    const errors = parsed.errors;
    if (!errors?.length) return `Request failed (${status})`;

    return errors
      .map((e) => {
        if (e.id === "ERR_INVALID_FIELD") {
          if (e.detail?.includes("/coordinates/lng"))
            return "Invalid longitude. Please re-save Lalamove Settings with a plain decimal (e.g. 120.9842).";
          if (e.detail?.includes("/coordinates/lat"))
            return "Invalid latitude. Please re-save Lalamove Settings with a plain decimal (e.g. 14.5995).";
          if (e.detail?.includes("/specialRequests"))
            return "Invalid special request option.";
          return `Invalid field: ${e.detail ?? e.message ?? e.id}`;
        }
        if (e.id === "ERR_INSUFFICIENT_STOPS")
          return "Missing pickup or delivery location. Check Lalamove Settings.";
        if (e.id === "ERR_UNAUTHORIZED")
          return "API authentication failed. Check Lalamove API keys.";
        if (e.id === "ERR_INVALID_MARKET")
          return "Invalid market configuration. Check Lalamove Settings.";
        return e.message ?? e.id;
      })
      .join("; ");
  } catch {
    return `Request failed [${status}]`;
  }
}

// ─── Coordinate sanitization ──────────────────────────────────────────────────
// Lalamove's coordinate regex requires a plain decimal string — no scientific
// notation, no excess precision. `String(0.0000123)` yields "1.23e-5", and raw
// values pasted into Lalamove Settings may carry whitespace or be malformed.
// `sanitizeCoordinate` parses, range-checks, and formats to a stable 6-decimal
// plain-decimal string (~11cm precision — well within Lalamove's 15-decimal max).

export function sanitizeCoordinate(
  value: string | number,
  field: "latitude" | "longitude",
): string {
  const n =
    typeof value === "number" ? value : parseFloat(String(value).trim());
  if (!Number.isFinite(n)) {
    const example = field === "latitude" ? "14.5995" : "120.9842";
    throw new Error(
      `Invalid ${field}: "${value}". Re-save Lalamove Settings with a plain decimal (e.g. ${example}).`,
    );
  }
  const limit = field === "latitude" ? 90 : 180;
  if (Math.abs(n) > limit) {
    throw new Error(`Invalid ${field}: ${n} is out of range (±${limit}).`);
  }
  return n.toFixed(6);
}

// ─── Base Request ─────────────────────────────────────────────────────────────

async function lalamoveRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { apiKey, apiSecret, baseUrl } = getLalamoveConfig();
  const bodyStr = body !== undefined ? JSON.stringify({ data: body }) : "";
  const auth = buildAuthHeader(apiKey, apiSecret, method, path, bodyStr);

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
      Market: "PH",
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(parseLalamoveError(res.status, errorText));
  }

  if (res.status === 204 || method === "DELETE") return undefined as T;
  const responseBody = (await res.json()) as { data: T };
  return responseBody.data;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LalamoveStop {
  coordinates: { lat: string; lng: string };
  address: string;
}

export interface LalamoveQuotationRequest {
  serviceType: string;
  stops: LalamoveStop[];
  specialRequests?: string[];
  scheduleAt?: string;
  language: string;
}

export interface LalamoveQuotationResponse {
  quotationId: string;
  expiresAt: string;
  priceBreakdown: {
    total: string;
    currency: string;
    base: string;
  };
  stops: Array<LalamoveStop & { stopId: string }>;
}

export interface LalamoveOrderRequest {
  quotationId: string;
  sender: { stopId: string; name: string; phone: string };
  recipients: Array<{
    stopId: string;
    name: string;
    phone: string;
    remarks?: string;
  }>;
  isPODEnabled?: boolean;
  metadata?: Record<string, string>;
}

export interface LalamoveOrderResponse {
  orderId: string;
  quotationId: string;
  status: LalamoveOrderStatus;
  driverId: string;
  shareLink: string;
  priceBreakdown: { total: string; currency: string };
}

export type LalamoveOrderStatus =
  | "ASSIGNING_DRIVER"
  | "ON_GOING"
  | "PICKED_UP"
  | "COMPLETED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

// ─── API Functions ────────────────────────────────────────────────────────────

export async function getQuotation(
  req: LalamoveQuotationRequest,
): Promise<LalamoveQuotationResponse> {
  return lalamoveRequest<LalamoveQuotationResponse>(
    "POST",
    "/v3/quotations",
    req,
  );
}

export async function placeOrder(
  req: LalamoveOrderRequest,
): Promise<LalamoveOrderResponse> {
  return lalamoveRequest<LalamoveOrderResponse>("POST", "/v3/orders", req);
}

export async function cancelLalamoveOrder(orderId: string): Promise<void> {
  await lalamoveRequest<void>("DELETE", `/v3/orders/${orderId}`);
}

export async function addPriorityFee(
  orderId: string,
  priorityFee: string,
  currency: string,
): Promise<void> {
  await lalamoveRequest<void>(
    "POST",
    `/v3/orders/${orderId}/priority-fee`,
    { priorityFee, currency },
  );
}

export async function registerLalamoveWebhook(webhookUrl: string): Promise<void> {
  await lalamoveRequest<void>("PATCH", "/v3/webhook", { url: webhookUrl });
}

// ─── Geocoding ────────────────────────────────────────────────────────────────

export async function geocodeAddress(
  address: string,
): Promise<{ lat: string; lng: string }> {
  const key = process.env.google_maps_api_key;
  if (!key) throw new Error("google_maps_api_key is not set in environment");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Maps geocoding HTTP ${res.status} for address: ${address}`);
  }
  const data = (await res.json()) as {
    status: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
    }>;
  };

  if (data.status !== "OK" || !data.results[0]) {
    throw new Error(`Geocoding failed (${data.status}): ${address}`);
  }

  const { lat, lng } = data.results[0].geometry.location;
  return {
    lat: sanitizeCoordinate(lat, "latitude"),
    lng: sanitizeCoordinate(lng, "longitude"),
  };
}

// ─── scheduleAt ───────────────────────────────────────────────────────────────
// Asia/Manila = UTC+8, no DST. Subtract 8 hours to convert to UTC.

export function buildScheduleAt(
  deliveryDate: string,
  timeSlot: string,
): string {
  const startHour = parseTimeWindowHour(timeSlot); // e.g. "9AM-12PM" → 9
  if (startHour === 999) {
    throw new Error(`buildScheduleAt: unrecognized timeSlot "${timeSlot}"`);
  }
  const [y, mo, d] = deliveryDate.split("-").map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, startHour - 8, 0, 0);
  return new Date(utcMs).toISOString();
}
