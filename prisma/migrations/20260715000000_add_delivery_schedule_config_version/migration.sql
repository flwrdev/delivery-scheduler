-- Scheduler V2 Phase 1 (docs/scheduler-v2-ux.md §4.4): optimistic-concurrency
-- version counter for DeliveryScheduleConfig. Additive and backfilled by the
-- DEFAULT, so existing rows keep working unchanged.
ALTER TABLE "DeliveryScheduleConfig" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
