import crypto from "node:crypto";

// Verifies an inbound Lalamove webhook POST using the same HMAC-SHA256
// formula Lalamove documents for its own OUTBOUND request signing:
//   SIGNATURE = HmacSHA256Hex(`${TIMESTAMP}\r\nPOST\r\n${PATH}\r\n\r\n${BODY}`, API_SECRET)
//
// UNVERIFIED (2026-08-16): Lalamove's webhook tutorial PDF is image-only and
// could not be parsed for the exact inbound header name/format — this
// mirrors the outbound `Authorization: hmac <key>:<timestamp>:<sig>` shape,
// which is the most likely inbound shape too, but it has not been confirmed
// against a real webhook delivery. Confirm on the first live webhook hit
// (temporarily log header names — never values — in dev) and update this
// file + docs/known-issues.md once confirmed.

// Same freshness window as this repo's verify-app-proxy.server.ts
// (MAX_SIGNATURE_AGE_SECONDS = 5*60), converted to milliseconds since
// Lalamove's own timestamp — and this app's outbound signing in
// lalamove-client.server.ts — is `Date.now()`, not Unix seconds. Without
// this, a validly-signed payload captured once (e.g. from the Lalamove
// Partner Portal's own visible "Webhook attempts" log) could be replayed
// indefinitely and still pass.
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_SKEW_MS = 60 * 1000;

export interface LalamoveWebhookAuthResult {
  ok: boolean;
  reason?: string;
}

export function verifyLalamoveWebhookSignature(
  rawBody: string,
  method: string,
  path: string,
  authorizationHeader: string | null,
  apiSecret: string,
): LalamoveWebhookAuthResult {
  if (!authorizationHeader) return { ok: false, reason: "missing Authorization header" };

  const match = authorizationHeader.match(/^hmac\s+([^:]+):(\d+):([0-9a-f]+)$/i);
  if (!match) return { ok: false, reason: "malformed Authorization header" };

  const [, , timestamp, providedHex] = match;

  const ageMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(ageMs) || ageMs > MAX_SIGNATURE_AGE_MS || ageMs < -MAX_SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "stale or future-dated timestamp" };
  }

  const raw = `${timestamp}\r\n${method}\r\n${path}\r\n\r\n${rawBody}`;
  const expectedHex = crypto.createHmac("sha256", apiSecret).update(raw).digest("hex");

  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, reason: "signature length mismatch" };
  }
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
