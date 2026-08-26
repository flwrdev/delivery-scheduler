// Chat-data retention purge (2026-08-24) — the counterweight to the agent
// channels' insert-only Postgres posture. Every customer turn on the support
// chat writes 1 SupportChatJob + 2 SupportChatMessage rows and nothing ever
// deleted them; the storefront widget is reachable from every page of the
// store, so left alone these tables grow without bound. This service is the
// nightly Cloud Scheduler-driven purge (route: internal.chat-retention.ts,
// same shared-secret pattern as internal.reminder-scan.ts).
//
// Retention policy (merchant decision 2026-08-24, "Standard" preset):
//   - SupportChatJob rows            > 7 days  — a job is a one-poll-cycle
//     artifact; the conversation itself lives in SupportChatMessage.
//   - storefront threads (whole thread: messages + jobs + thread row)
//     idle    > 30 days — anonymous, localStorage-keyed; a visitor who
//     cleared storage can never resume the old thread anyway.
//   - customer-account MESSAGES      > 90 days — the thread row itself is
//     kept (one per customer, id = customerGid, cheap) so a returning
//     customer keeps their thread identity; only old messages age out.
//   - AgentRateLimit rows stale      > 2 days  — windows are 60 minutes;
//     anything older is dead weight.
//   - LookupAttempt rows stale       > 30 days — lockouts expire in minutes;
//     old keys are abandoned conversations.
//   - MessengerThread / MessengerMessage: DELIBERATELY UNTOUCHED — live
//     ordering state (conversationOrderKey, humanControl) rides on those
//     rows; purging them is a product decision, not a hygiene task.
//
// ZERO Shopify writes (no Admin API import at all) — everything here is
// Postgres-side deletes, same side-table posture as the models themselves.
// Log hygiene: counts and cutoffs only — never message text.

import prisma from "../db.server";

export const RETENTION = {
  jobsDays: 7,
  storefrontThreadIdleDays: 30,
  customerAccountMessageDays: 90,
  rateLimitStaleDays: 2,
  lookupAttemptStaleDays: 30,
  // ADR-22 ops work queues (2026-08-27) — same transient-bookkeeping posture:
  //   - finished BulkActionJob rows (+ items via FK cascade) > 7 days;
  //   - DONE DeliverySyncTask rows > 30 days. FAILED sync tasks are
  //     deliberately KEPT — they feed the ops-page banner until the merchant
  //     retries them into done; auto-purging them would hide a real problem.
  bulkJobFinishedDays: 7,
  deliverySyncDoneDays: 30,
} as const;

// Cap on storefront threads deleted per run — the scheduler runs daily, so a
// backlog drains across runs instead of one long transaction holding locks.
const STOREFRONT_THREAD_BATCH = 500;

export interface ChatRetentionSummary {
  ok: true;
  jobsDeleted: number;
  storefrontThreadsDeleted: number;
  storefrontMessagesDeleted: number;
  storefrontJobsDeleted: number;
  customerAccountMessagesDeleted: number;
  rateLimitRowsDeleted: number;
  lookupAttemptsDeleted: number;
  bulkJobsDeleted: number;
  deliverySyncTasksDeleted: number;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function runChatRetentionPurge(now: Date = new Date()): Promise<ChatRetentionSummary> {
  const jobCutoff = daysAgo(now, RETENTION.jobsDays);
  const storefrontCutoff = daysAgo(now, RETENTION.storefrontThreadIdleDays);
  const caMessageCutoff = daysAgo(now, RETENTION.customerAccountMessageDays);
  const rateLimitCutoff = daysAgo(now, RETENTION.rateLimitStaleDays);
  const lookupCutoff = daysAgo(now, RETENTION.lookupAttemptStaleDays);

  // 1. Stale jobs, any status, any channel. Children of the thread relation,
  //    so no FK ordering concern.
  const jobs = await prisma.supportChatJob.deleteMany({
    where: { createdAt: { lt: jobCutoff } },
  });

  // 2. Customer-account messages past the 90-day window. The thread row is
  //    kept — see the header. Relation filter keeps this off storefront rows,
  //    which step 3 handles wholesale.
  const caMessages = await prisma.supportChatMessage.deleteMany({
    where: {
      createdAt: { lt: caMessageCutoff },
      thread: { channel: "customer-account" },
    },
  });

  // 3. Idle storefront threads — whole-thread delete (messages + jobs + the
  //    thread row itself). updatedAt refreshes on every turn's upsert, so
  //    "idle" is real inactivity, not thread age. Children first: the Prisma
  //    relations have no cascade, deleting the thread under live children
  //    would violate the FK.
  const staleThreads = await prisma.supportChatThread.findMany({
    where: { channel: "storefront", updatedAt: { lt: storefrontCutoff } },
    select: { id: true },
    take: STOREFRONT_THREAD_BATCH,
  });
  const staleIds = staleThreads.map((thread: { id: string }) => thread.id);

  let storefrontMessagesDeleted = 0;
  let storefrontJobsDeleted = 0;
  let storefrontThreadsDeleted = 0;
  if (staleIds.length > 0) {
    const [messages, threadJobs, threads] = await prisma.$transaction([
      prisma.supportChatMessage.deleteMany({ where: { threadId: { in: staleIds } } }),
      prisma.supportChatJob.deleteMany({ where: { threadId: { in: staleIds } } }),
      // Re-assert the idle cutoff: a thread that took a message between the
      // findMany above and this transaction stays, and its just-orphaned
      // history is an accepted near-zero-probability loss (a 30-day-idle
      // thread would have to wake in this exact second).
      prisma.supportChatThread.deleteMany({
        where: { id: { in: staleIds }, updatedAt: { lt: storefrontCutoff } },
      }),
    ]);
    storefrontMessagesDeleted = messages.count;
    storefrontJobsDeleted = threadJobs.count;
    storefrontThreadsDeleted = threads.count;
  }

  // 4. Dead rate-limit windows and abandoned lookup-attempt keys.
  const rateLimits = await prisma.agentRateLimit.deleteMany({
    where: { updatedAt: { lt: rateLimitCutoff } },
  });
  const lookups = await prisma.lookupAttempt.deleteMany({
    where: { updatedAt: { lt: lookupCutoff } },
  });

  // 5. ADR-22 ops work queues: finished bulk jobs (items ride the FK cascade)
  //    and DONE delivery-sync tasks. Failed sync tasks are kept — see the
  //    RETENTION comment.
  const bulkJobs = await prisma.bulkActionJob.deleteMany({
    where: {
      status: { in: ["done", "failed"] },
      updatedAt: { lt: daysAgo(now, RETENTION.bulkJobFinishedDays) },
    },
  });
  const syncTasks = await prisma.deliverySyncTask.deleteMany({
    where: {
      status: "done",
      updatedAt: { lt: daysAgo(now, RETENTION.deliverySyncDoneDays) },
    },
  });

  const summary: ChatRetentionSummary = {
    ok: true,
    jobsDeleted: jobs.count,
    storefrontThreadsDeleted,
    storefrontMessagesDeleted,
    storefrontJobsDeleted,
    customerAccountMessagesDeleted: caMessages.count,
    rateLimitRowsDeleted: rateLimits.count,
    lookupAttemptsDeleted: lookups.count,
    bulkJobsDeleted: bulkJobs.count,
    deliverySyncTasksDeleted: syncTasks.count,
  };
  console.log(
    `[chat-retention] purge done jobs=${summary.jobsDeleted} sfThreads=${summary.storefrontThreadsDeleted} ` +
      `sfMessages=${summary.storefrontMessagesDeleted} sfJobs=${summary.storefrontJobsDeleted} ` +
      `caMessages=${summary.customerAccountMessagesDeleted} rateLimit=${summary.rateLimitRowsDeleted} ` +
      `lookups=${summary.lookupAttemptsDeleted} bulkJobs=${summary.bulkJobsDeleted} ` +
      `syncTasks=${summary.deliverySyncTasksDeleted}`,
  );
  return summary;
}
