import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyLalamoveWebhookSignature } from "../app/lib/verify-lalamove-signature.server";

const SECRET = "hush";
const PATH = "/webhooks/lalamove-tracking";

function sign(body: string, timestamp: string, secret = SECRET): string {
  const raw = `${timestamp}\r\nPOST\r\n${PATH}\r\n\r\n${body}`;
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

function authHeader(body: string, { timestamp = Date.now().toString(), secret = SECRET, apiKey = "key123" } = {}) {
  return `hmac ${apiKey}:${timestamp}:${sign(body, timestamp, secret)}`;
}

describe("verifyLalamoveWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ eventType: "ORDER_STATUS_CHANGED" });
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, authHeader(body), SECRET);
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ eventType: "ORDER_STATUS_CHANGED" });
    const header = authHeader(body);
    const tampered = JSON.stringify({ eventType: "ORDER_CREATED" });
    const result = verifyLalamoveWebhookSignature(tampered, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ eventType: "ORDER_CREATED" });
    const header = authHeader(body, { secret: "wrong-secret" });
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    const result = verifyLalamoveWebhookSignature("{}", "POST", PATH, null, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects a malformed Authorization header", () => {
    const result = verifyLalamoveWebhookSignature("{}", "POST", PATH, "Bearer abc123", SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/malformed/i);
  });

  it("rejects when the path used to sign differs from the verification path", () => {
    const body = JSON.stringify({ eventType: "ORDER_CREATED" });
    const timestamp = Date.now().toString();
    const wrongPathSig = crypto
      .createHmac("sha256", SECRET)
      .update(`${timestamp}\r\nPOST\r\n/some/other/path\r\n\r\n${body}`)
      .digest("hex");
    const header = `hmac key123:${timestamp}:${wrongPathSig}`;
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects a correctly-signed but stale (replayed) timestamp", () => {
    const body = JSON.stringify({ eventType: "ORDER_STATUS_CHANGED" });
    const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 min old
    const header = authHeader(body, { timestamp: staleTimestamp });
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stale|future/i);
  });

  it("rejects a correctly-signed but far-future timestamp", () => {
    const body = JSON.stringify({ eventType: "ORDER_STATUS_CHANGED" });
    const futureTimestamp = (Date.now() + 10 * 60 * 1000).toString();
    const header = authHeader(body, { timestamp: futureTimestamp });
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(false);
  });

  it("accepts a timestamp within the freshness window", () => {
    const body = JSON.stringify({ eventType: "ORDER_STATUS_CHANGED" });
    const recentTimestamp = (Date.now() - 60 * 1000).toString(); // 1 min old
    const header = authHeader(body, { timestamp: recentTimestamp });
    const result = verifyLalamoveWebhookSignature(body, "POST", PATH, header, SECRET);
    expect(result.ok).toBe(true);
  });
});
