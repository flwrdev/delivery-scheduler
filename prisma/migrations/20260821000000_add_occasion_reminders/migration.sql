-- Hand-written (repo standing rule: never `prisma migrate dev` / shadow DB —
-- see docs/known-issues.md, 2026-08-01 incident). Mirrors schema.prisma.

-- CreateTable
CREATE TABLE "OccasionReminder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "occasionDate" DATE NOT NULL,
    "occasionYear" INTEGER NOT NULL,
    "occasionType" TEXT NOT NULL,
    "touch" TEXT NOT NULL,
    "detectSource" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerFirstName" TEXT,
    "recipientHint" TEXT,
    "cardMessageExcerpt" TEXT,
    "productTitles" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "priorYearsSent" INTEGER NOT NULL DEFAULT 0,
    "suggestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OccasionReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderSuppression" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "source" TEXT NOT NULL DEFAULT 'unsubscribe_link',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderConfig" (
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderConfig_pkey" PRIMARY KEY ("shop")
);

-- CreateIndex
CREATE UNIQUE INDEX "OccasionReminder_shop_shopifyOrderId_occasionYear_touch_key" ON "OccasionReminder"("shop", "shopifyOrderId", "occasionYear", "touch");

-- CreateIndex
CREATE INDEX "OccasionReminder_shop_status_occasionDate_idx" ON "OccasionReminder"("shop", "status", "occasionDate");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderSuppression_shop_email_scope_key" ON "ReminderSuppression"("shop", "email", "scope");

-- CreateIndex
CREATE INDEX "ReminderSuppression_shop_email_idx" ON "ReminderSuppression"("shop", "email");
