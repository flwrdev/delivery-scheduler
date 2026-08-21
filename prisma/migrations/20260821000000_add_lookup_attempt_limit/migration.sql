-- Order-number+zip lookup anti-guessing guard (2026-08-21): counts consecutive
-- failed lookup attempts per thread and locks the tool out for a cooldown
-- window once the threshold is hit (see order-lookup.server.ts).
ALTER TABLE "MessengerThread" ADD COLUMN "lookupFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MessengerThread" ADD COLUMN "lookupLockedAt" TIMESTAMP(3);
