  import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyMetaWebhookSignature } from "../app/lib/verify-meta-signature.server";

const SECRET = "meta-app-secret";

// Meta signs the raw request body with HMAC-SHA256 of the app secret and sends
// it as `X-Hub-Signature-256: sha256=<hex>` — fixtures are built the same way.
// https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads
function sign(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    expect(verifyMetaWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts a body containing multi-byte UTF-8 characters", () => {
    const body = JSON.stringify({ object: "page", text: "Salamat pô! 🌸" });
    expect(verifyMetaWebhookSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ object: "page" });
    expect(verifyMetaWebhookSignature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const body = JSON.stringify({ object: "page" });
    const header = sign(body, SECRET);
    expect(verifyMetaWebhookSignature(`${body} `, header, SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    const body = JSON.stringify({ object: "page" });
    expect(verifyMetaWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = JSON.stringify({ object: "page" });
    const bareHex = sign(body, SECRET).slice("sha256=".length);
    expect(verifyMetaWebhookSignature(body, `sha1=${bareHex}`, SECRET)).toBe(false);
  });

  it("rejects a non-hex digest", () => {
    const body = JSON.stringify({ object: "page" });
    expect(verifyMetaWebhookSignature(body, "sha256=not-hex!!", SECRET)).toBe(false);
  });

  it("rejects a truncated hex digest without throwing", () => {
    const body = JSON.stringify({ object: "page" });
    const truncated = sign(body, SECRET).slice(0, "sha256=".length + 10);
    expect(() => verifyMetaWebhookSignature(body, truncated, SECRET)).not.toThrow();
    expect(verifyMetaWebhookSignature(body, truncated, SECRET)).toBe(false);
  });
});
