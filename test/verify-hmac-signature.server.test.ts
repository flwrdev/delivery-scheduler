import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyHmacSha256Signature } from "../app/lib/verify-hmac-signature.server";

const SECRET = "worker-signing-secret";

function sign(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

describe("verifyHmacSha256Signature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ deliverySyncTaskId: "t1" });
    expect(verifyHmacSha256Signature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts a body containing multi-byte UTF-8 characters", () => {
    const body = JSON.stringify({ text: "Salamat pô! 🌸" });
    expect(verifyHmacSha256Signature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyHmacSha256Signature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ a: 1 });
    const header = sign(body, SECRET);
    expect(verifyHmacSha256Signature(`${body} `, header, SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyHmacSha256Signature("{}", null, SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const bareHex = sign(body, SECRET).slice("sha256=".length);
    expect(verifyHmacSha256Signature(body, `sha1=${bareHex}`, SECRET)).toBe(false);
  });

  it("rejects a non-hex digest", () => {
    expect(verifyHmacSha256Signature("{}", "sha256=not-hex!!", SECRET)).toBe(false);
  });

  it("rejects a truncated hex digest without throwing", () => {
    const body = "{}";
    const truncated = sign(body, SECRET).slice(0, "sha256=".length + 10);
    expect(() => verifyHmacSha256Signature(body, truncated, SECRET)).not.toThrow();
    expect(verifyHmacSha256Signature(body, truncated, SECRET)).toBe(false);
  });
});
