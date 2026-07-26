import crypto from "node:crypto";

// Meta (Facebook Messenger) signs every webhook POST with an HMAC-SHA256 hex
// digest of the RAW request body using the app secret, delivered as
// `X-Hub-Signature-256: sha256=<hex>`.
// (https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads)
// Callers must read the body with `request.text()` FIRST and JSON.parse after
// verification — never verify a re-serialized body, since Meta signs the exact
// bytes it sent.
const SIGNATURE_PREFIX = "sha256=";

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) return false;

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;

  const expectedHex = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
