import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_RATE_LIMITS,
  checkAgentRateLimit,
  extractAgentToken,
  gateAgentRequest,
  resetAgentRateLimits,
  verifyAgentRequest,
} from "../app/lib/verify-agent-token.server";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/agent/orders/status", { headers });
}

describe("extractAgentToken", () => {
  it("reads a Bearer token", () => {
    expect(extractAgentToken(req({ Authorization: "Bearer abc123" }))).toBe("abc123");
    expect(extractAgentToken(req({ authorization: "bearer   spaced  " }))).toBe("spaced");
  });

  it("falls back to X-Api-Key", () => {
    expect(extractAgentToken(req({ "X-Api-Key": "key-1" }))).toBe("key-1");
  });

  it("returns null when neither header carries a value", () => {
    expect(extractAgentToken(req())).toBeNull();
    expect(extractAgentToken(req({ Authorization: "Bearer " }))).toBeNull();
  });
});

describe("verifyAgentRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 503 when no token is configured", () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "");
    vi.stubEnv("META_AGENT_API_TOKEN_PREV", "");
    const result = verifyAgentRequest(req({ Authorization: "Bearer x" }));
    expect(result).toMatchObject({ ok: false, status: 503, code: "not_configured" });
  });

  it("returns 401 when the header is missing or wrong", () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "correct-token");
    expect(verifyAgentRequest(req())).toMatchObject({ ok: false, status: 401 });
    expect(verifyAgentRequest(req({ Authorization: "Bearer wrong" }))).toMatchObject({ ok: false, status: 401 });
    expect(verifyAgentRequest(req({ Authorization: "Bearer correct-toke" }))).toMatchObject({ ok: false, status: 401 });
  });

  it("accepts the current token and the previous token during rotation", () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "new-token");
    vi.stubEnv("META_AGENT_API_TOKEN_PREV", "old-token");
    expect(verifyAgentRequest(req({ Authorization: "Bearer new-token" }))).toEqual({ ok: true });
    expect(verifyAgentRequest(req({ "X-Api-Key": "old-token" }))).toEqual({ ok: true });
  });
});

describe("checkAgentRateLimit", () => {
  afterEach(() => resetAgentRateLimits());

  it("allows up to the limit inside the window, then rejects with a retry hint", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      expect(checkAgentRateLimit({ key: "k", limit: 3, windowMs: 60_000, now: now + i * 1000 })).toEqual({ ok: true });
    }
    const rejected = checkAgentRateLimit({ key: "k", limit: 3, windowMs: 60_000, now: now + 5000 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.retryAfterSeconds).toBe(55);
  });

  it("forgets hits that fall outside the window", () => {
    const now = 1_000_000;
    expect(checkAgentRateLimit({ key: "k2", limit: 1, windowMs: 60_000, now })).toEqual({ ok: true });
    expect(checkAgentRateLimit({ key: "k2", limit: 1, windowMs: 60_000, now: now + 61_000 })).toEqual({ ok: true });
  });

  it("keeps separate counters per key", () => {
    expect(checkAgentRateLimit({ key: "a", limit: 1 })).toEqual({ ok: true });
    expect(checkAgentRateLimit({ key: "b", limit: 1 })).toEqual({ ok: true });
    expect(checkAgentRateLimit({ key: "a", limit: 1 }).ok).toBe(false);
  });
});

describe("gateAgentRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetAgentRateLimits();
  });

  it("returns a 401 JSON error response for a bad token", async () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "t");
    const response = gateAgentRequest(req({ Authorization: "Bearer nope" }), "status");
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("returns null when the token is valid and under the limit", () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "t");
    expect(gateAgentRequest(req({ Authorization: "Bearer t" }), "status")).toBeNull();
  });

  it("returns 429 with Retry-After once the endpoint limit is exhausted", async () => {
    vi.stubEnv("META_AGENT_API_TOKEN", "t");
    for (let i = 0; i < AGENT_RATE_LIMITS.draft; i += 1) {
      expect(gateAgentRequest(req({ Authorization: "Bearer t" }), "draft")).toBeNull();
    }
    const response = gateAgentRequest(req({ Authorization: "Bearer t" }), "draft");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await response?.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});
