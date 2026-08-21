-- Support chat backend (customer-account extension, agent-core phase 2):
-- enqueue-then-poll job records. Neon holds conversation + job status only —
-- never the order (order state lives on the Shopify order, per architecture).

CREATE TABLE "SupportChatThread" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerGid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "bodyJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportChatMessage_threadId_createdAt_idx" ON "SupportChatMessage"("threadId", "createdAt");

CREATE TABLE "SupportChatJob" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "blocksJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportChatJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportChatJob_threadId_createdAt_idx" ON "SupportChatJob"("threadId", "createdAt");

ALTER TABLE "SupportChatMessage" ADD CONSTRAINT "SupportChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportChatThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupportChatJob" ADD CONSTRAINT "SupportChatJob_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportChatThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
