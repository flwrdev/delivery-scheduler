-- Turn-volume rate limiting for LLM-backed agent channels (storefront widget,
-- 2026-08-22). Distinct from LookupAttempt, which only throttles the
-- order-lookup TOOL specifically. This throttles general message/turn volume
-- per caller, keyed by an opaque string ("conv:<conversationId>" or
-- "ip:<address>") -- no server-verified identity required, same posture as
-- LookupAttempt.
CREATE TABLE "AgentRateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRateLimit_pkey" PRIMARY KEY ("key")
);
