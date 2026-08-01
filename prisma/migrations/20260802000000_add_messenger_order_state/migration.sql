-- Phase 6 (draft order + invoice): slot-filling state + idempotency key.
-- Neon holds the conversation and the order KEY, never the order itself.
ALTER TABLE "MessengerThread" ADD COLUMN "orderStateJson" TEXT;
ALTER TABLE "MessengerThread" ADD COLUMN "conversationOrderKey" TEXT;
