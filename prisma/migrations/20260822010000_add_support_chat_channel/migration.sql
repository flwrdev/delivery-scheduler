-- Storefront chat widget (2026-08-22): SupportChatThread now serves two
-- channels (customer-account, storefront). runSupportChatTurn reads this
-- column to reconstruct the right AgentChannel per job instead of assuming
-- customer-account everywhere -- see support-chat-turn.server.ts. Default
-- keeps every pre-existing row (all customer-account today) correct with no
-- backfill needed.
ALTER TABLE "SupportChatThread" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'customer-account';
