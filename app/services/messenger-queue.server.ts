// Cloud Tasks enqueue for the Messenger agent and support-chat workers.
// Shares the task POST core with ops-queue.server.ts.

import { OPS_QUEUE_NOT_CONFIGURED_MESSAGE, postCloudTask, signWorkerPayload } from "./ops-queue.server";
import type { EnqueueTaskResult } from "./ops-queue.server";

export const MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE = OPS_QUEUE_NOT_CONFIGURED_MESSAGE;

export { signWorkerPayload };
export { OPS_WORKER_SIGNATURE_HEADER as MESSENGER_WORKER_SIGNATURE_HEADER } from "./ops-queue.server";

export type EnqueueMessengerEchoTaskResult = EnqueueTaskResult;

export interface EnqueueMessengerEchoTaskInput {
  mid: string;
}

function messengerQueueOptions(workerUrlOverride?: string, scheduleTime?: string) {
  return {
    queuePath: process.env.MESSENGER_TASKS_QUEUE_PATH?.trim() ?? "",
    workerUrl: workerUrlOverride ?? process.env.MESSENGER_WORKER_URL?.trim() ?? "",
    secret: process.env.MESSENGER_WORKER_SECRET?.trim() ?? "",
    scheduleTime,
  };
}

export async function enqueueMessengerEchoTask({
  mid,
}: EnqueueMessengerEchoTaskInput): Promise<EnqueueMessengerEchoTaskResult> {
  return postCloudTask(JSON.stringify({ mid }), messengerQueueOptions());
}

export interface EnqueueMessengerFollowUpTaskInput {
  psid: string;
  orderKey: string;
  delaySeconds: number;
}

export async function enqueueMessengerFollowUpTask({
  psid,
  orderKey,
  delaySeconds,
}: EnqueueMessengerFollowUpTaskInput): Promise<EnqueueMessengerEchoTaskResult> {
  const scheduleTime = new Date(Date.now() + delaySeconds * 1000).toISOString();
  return postCloudTask(
    JSON.stringify({ followUp: { psid, orderKey } }),
    messengerQueueOptions(undefined, scheduleTime),
  );
}

// Prefers SUPPORT_CHAT_WORKER_URL; otherwise derives the URL from
// MESSENGER_WORKER_URL by swapping the path.
function resolveSupportChatWorkerUrl(): string | undefined {
  const explicit = process.env.SUPPORT_CHAT_WORKER_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const messengerWorkerUrl = process.env.MESSENGER_WORKER_URL?.trim();
  if (!messengerWorkerUrl) {
    return undefined;
  }
  try {
    const url = new URL(messengerWorkerUrl);
    const swappedPathname = url.pathname.replace(
      /\/webhooks\/messenger\/worker\/?$/,
      "/webhooks/support-chat/worker",
    );
    if (swappedPathname === url.pathname) {
      console.error(
        "[support-chat] resolveSupportChatWorkerUrl: MESSENGER_WORKER_URL path did not match the expected " +
          "/webhooks/messenger/worker suffix, so no support-chat worker URL could be derived. Set SUPPORT_CHAT_WORKER_URL explicitly.",
      );
      return undefined;
    }
    url.pathname = swappedPathname;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface EnqueueSupportChatTaskInput {
  jobId: string;
}

export async function enqueueSupportChatTask({
  jobId,
}: EnqueueSupportChatTaskInput): Promise<EnqueueMessengerEchoTaskResult> {
  const workerUrl = resolveSupportChatWorkerUrl();
  if (!workerUrl) {
    return { ok: false, error: MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }
  return postCloudTask(JSON.stringify({ jobId }), messengerQueueOptions(workerUrl));
}
