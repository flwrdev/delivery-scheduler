import crypto from "node:crypto";

// Bearer-token auth and per-endpoint rate limiting for the /api/agent/*
// routes called by the Meta Business Agent tools.

export type AgentAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: string; message: string };

export const AGENT_RATE_LIMITS = {
  draft: 20,
  status: 60,
  quote: 60,
} as const;

const RATE_WINDOW_MS = 60 * 1000;
const buckets = new Map<string, number[]>();

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function configuredTokens(): string[] {
  return [process.env.META_AGENT_API_TOKEN, process.env.META_AGENT_API_TOKEN_PREV]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
}

// Accepts `Authorization: Bearer <token>` or `X-Api-Key: <token>`.
export function extractAgentToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (/^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, "").trim();
    return token.length > 0 ? token : null;
  }
  const apiKey = request.headers.get("x-api-key")?.trim() ?? "";
  return apiKey.length > 0 ? apiKey : null;
}

export function verifyAgentRequest(request: Request): AgentAuthResult {
  const tokens = configuredTokens();
  if (tokens.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      message: "Agent API is not configured on this environment.",
    };
  }
  const provided = extractAgentToken(request);
  if (!provided) {
    return { ok: false, status: 401, code: "unauthorized", message: "Missing API token." };
  }
  const matched = tokens.some((token) => timingSafeEqualStrings(provided, token));
  if (!matched) {
    return { ok: false, status: 401, code: "unauthorized", message: "Invalid API token." };
  }
  return { ok: true };
}

export interface RateLimitCheck {
  key: string;
  limit: number;
  windowMs?: number;
  now?: number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// Sliding-window counter kept in process memory, keyed per endpoint.
export function checkAgentRateLimit({
  key,
  limit,
  windowMs = RATE_WINDOW_MS,
  now = Date.now(),
}: RateLimitCheck): RateLimitResult {
  const recent = (buckets.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    const oldest = recent[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, recent);
    return { ok: false, retryAfterSeconds };
  }
  recent.push(now);
  buckets.set(key, recent);
  return { ok: true };
}

export function resetAgentRateLimits(): void {
  buckets.clear();
}

export function agentErrorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { code, message, ...extra } },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export function agentJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Runs auth + rate limit for one endpoint; returns a Response on rejection.
export function gateAgentRequest(request: Request, endpoint: keyof typeof AGENT_RATE_LIMITS): Response | null {
  const auth = verifyAgentRequest(request);
  if (!auth.ok) {
    return agentErrorResponse(auth.status, auth.code, auth.message);
  }
  const limit = checkAgentRateLimit({ key: `agent:${endpoint}`, limit: AGENT_RATE_LIMITS[endpoint] });
  if (!limit.ok) {
    return agentErrorResponse(
      429,
      "rate_limited",
      "Too many requests. Subukan ulit sa ilang sandali.",
      { retryAfterSeconds: limit.retryAfterSeconds },
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }
  return null;
}
