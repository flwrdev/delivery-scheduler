import crypto from "node:crypto";

// Verifies a `sha256=<hex>` HMAC-SHA256 signature computed over the raw
// request body with the given secret. Callers must pass the exact bytes
// received (request.text()), not a re-serialized body.
const SIGNATURE_PREFIX = "sha256=";

export function verifyHmacSha256Signature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) return false;

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(providedHex)) return false;

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
