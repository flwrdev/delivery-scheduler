-- Hand-written (repo standing rule: never `prisma migrate dev` / shadow DB —
-- see docs/known-issues.md, 2026-08-01 incident). Mirrors schema.prisma.
--
-- Removes the occasion-reminder feature (ADR-19). Merchant moved to a dedicated
-- third-party Shopify reminder app; the in-app scan detected nothing (its
-- year-over-year design needs a `custom.date` metafield that pre-migration
-- orders never had). No data of value is lost (OccasionReminder was empty).
-- EmailSendLog is intentionally KEPT — it is shared with the manual "Send email"
-- feature on /app/orders.

-- DropTable
DROP TABLE IF EXISTS "OccasionReminder" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "ReminderSuppression" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "ReminderConfig" CASCADE;
