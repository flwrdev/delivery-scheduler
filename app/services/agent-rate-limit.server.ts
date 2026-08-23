// Turn-volume rate limiting for LLM-backed agent channels (storefront widget,
// 2026-08-22) — distinct from LookupAttempt (order-lookup.server.ts), which
// only throttles the order-lookup TOOL specifically. This throttles general
// message/turn volume per caller, keyed by an opaque string
// ("conv:<conversationId>" or "ip:<address>") — no server-verified identity
// required, same posture as LookupAttempt.
//
// Fail-open on any Prisma error: availability of support beats a slightly
// weaker guard on a transient DB hiccup (same call order-lookup.server.ts
// makes for its own lockout).

import prisma from "../db.server";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter, check-and-record in one call. A window that has
 * already expired resets the count to 0 BEFORE counting this call — the same
 * fix order-lookup.server.ts's recordLookupFailure had to apply once after
 * shipping without it: a call made just after an old window expired must NOT
 * inherit the old count and immediately re-trip the limit.
 */
export async function checkAndRecordAgentRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  try {
    const existing = await prisma.agentRateLimit.findUnique({
      where: { key },
      select: { windowStart: true, count: true },
    });

    const windowExpired =
      !!existing && now.getTime() - existing.windowStart.getTime() >= windowMs;
    const windowStart = !existing || windowExpired ? now : existing.windowStart;
    const baseCount = !existing || windowExpired ? 0 : existing.count;
    const nextCount = baseCount + 1;
    const allowed = nextCount <= limit;

    await prisma.agentRateLimit.upsert({
      where: { key },
      create: { key, windowStart, count: nextCount },
      update: { windowStart, count: nextCount },
    });

    const retryAfterSeconds = allowed
      ? 0
      : Math.max(0, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));

    return { allowed, retryAfterSeconds };
  } catch (error) {
    console.warn(
      `[agent-rate-limit] check failed key=${key}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
