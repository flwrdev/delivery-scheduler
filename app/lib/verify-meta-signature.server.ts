// Meta signs webhook POSTs as `X-Hub-Signature-256: sha256=<hex>` over the raw
// body with the app secret. Same scheme as verifyHmacSha256Signature.
export { verifyHmacSha256Signature as verifyMetaWebhookSignature } from "./verify-hmac-signature.server";
