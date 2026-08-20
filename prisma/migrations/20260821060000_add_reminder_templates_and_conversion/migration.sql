-- Hand-written (repo standing rule: never `prisma migrate dev` / shadow DB).
-- ADR-19 addendum: merchant-editable templates + conversion attribution.

-- AlterTable
ALTER TABLE "OccasionReminder" ADD COLUMN "convertedAt" TIMESTAMP(3);
ALTER TABLE "OccasionReminder" ADD COLUMN "convertedOrderId" TEXT;

-- AlterTable
ALTER TABLE "ReminderConfig" ADD COLUMN "subject7d" TEXT;
ALTER TABLE "ReminderConfig" ADD COLUMN "body7d" TEXT;
ALTER TABLE "ReminderConfig" ADD COLUMN "subject3d" TEXT;
ALTER TABLE "ReminderConfig" ADD COLUMN "body3d" TEXT;
