-- Channel-agnostic order-lookup anti-guessing guard (2026-08-21 addendum).
-- Supersedes MessengerThread.lookupFailures/lookupLockedAt, which is keyed
-- by psid and therefore never populated for the web channels (see
-- order-lookup.server.ts). Those two columns are left in place on
-- MessengerThread (dropping columns is destructive) but are no longer read
-- or written by application code.
CREATE TABLE "LookupAttempt" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LookupAttempt_pkey" PRIMARY KEY ("key")
);
