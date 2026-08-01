-- CreateTable
CREATE TABLE "MessengerThread" (
    "psid" TEXT NOT NULL,
    "humanControl" BOOLEAN NOT NULL DEFAULT false,
    "humanControlAt" TIMESTAMP(3),
    "lastCustomerAt" TIMESTAMP(3),
    "disclosedBot" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "shopifyCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessengerThread_pkey" PRIMARY KEY ("psid")
);

-- CreateTable
CREATE TABLE "MessengerMessage" (
    "id" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "bodyJson" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3),
    "replyMid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessengerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessengerMessage_mid_key" ON "MessengerMessage"("mid");

-- CreateIndex
CREATE INDEX "MessengerMessage_psid_createdAt_idx" ON "MessengerMessage"("psid", "createdAt");

-- AddForeignKey
ALTER TABLE "MessengerMessage" ADD CONSTRAINT "MessengerMessage_psid_fkey" FOREIGN KEY ("psid") REFERENCES "MessengerThread"("psid") ON DELETE RESTRICT ON UPDATE CASCADE;

