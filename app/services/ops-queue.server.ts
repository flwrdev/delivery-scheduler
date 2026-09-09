// Cloud Tasks enqueue for the ops work rails: the orders/create delivery
// sync (webhooks/delivery-sync/worker) and /app/orders bulk-action jobs
// (webhooks/bulk-action/worker). Each task carries an HMAC-SHA256 signature
// over its raw payload, verified by the worker route with
// verifyHmacSha256Signature.

import crypto from "node:crypto";

export const OPS_QUEUE_NOT_CONFIGURED_MESSAGE =
  "Ops task queue is not configured on this environment.";

// Header name shared by the signing side (here) and the worker routes.
export const OPS_WORKER_SIGNATURE_HEADER = "X-Messenger-Worker-Signature";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const FETCH_TIMEOUT_MS = 5000;
const DISPATCH_DEADLINE = "180s";

export type EnqueueTaskResult =
  | { ok: true; taskName: string }
  | { ok: false; error: string; notConfigured?: boolean };

export interface PostCloudTaskOptions {
  queuePath: string;
  workerUrl: string;
  secret: string;
  scheduleTime?: string;
}

export function signWorkerPayload(rawPayload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawPayload, "utf8").digest("hex")}`;
}

async function fetchAccessToken(): Promise<string | null> {
  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { access_token?: string };
  return payload.access_token ?? null;
}

// Creates one Cloud Task that POSTs the signed payload to workerUrl.
export async function postCloudTask(
  rawPayload: string,
  options: PostCloudTaskOptions,
): Promise<EnqueueTaskResult> {
  const { queuePath, workerUrl, secret, scheduleTime } = options;
  if (!queuePath || !workerUrl || !secret) {
    return { ok: false, error: OPS_QUEUE_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }

  try {
    const accessToken = await fetchAccessToken();
    if (!accessToken) {
      return { ok: false, error: "Could not obtain a Cloud Tasks access token." };
    }

    const response = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        task: {
          httpRequest: {
            url: workerUrl,
            httpMethod: "POST",
            headers: {
              "Content-Type": "application/json",
              [OPS_WORKER_SIGNATURE_HEADER]: signWorkerPayload(rawPayload, secret),
            },
            body: Buffer.from(rawPayload, "utf8").toString("base64"),
          },
          dispatchDeadline: DISPATCH_DEADLINE,
          ...(scheduleTime ? { scheduleTime } : {}),
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    let payload: { name?: string; error?: { message?: string } } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body: fall through to the status-based error below.
    }

    if (!response.ok) {
      const apiMessage = payload.error?.message ?? "unknown error";
      return { ok: false, error: `Cloud Tasks ${response.status}: ${apiMessage}` };
    }

    return { ok: true, taskName: payload.name ?? "" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to enqueue task.",
    };
  }
}

// Env resolution: OPS_* first, then the legacy MESSENGER_* names.
export function resolveOpsWorkerSecret(): string | undefined {
  return (
    process.env.OPS_WORKER_SECRET?.trim() ||
    process.env.MESSENGER_WORKER_SECRET?.trim() ||
    undefined
  );
}

export function resolveOpsQueuePath(): string | undefined {
  return (
    process.env.OPS_TASKS_QUEUE_PATH?.trim() ||
    process.env.MESSENGER_TASKS_QUEUE_PATH?.trim() ||
    undefined
  );
}

// Explicit env wins; otherwise derive the worker URL from OPS_WORKER_BASE_URL
// or the legacy MESSENGER_WORKER_URL by replacing its path.
function resolveWorkerUrl(explicitEnv: string, targetPath: string, label: string): string | undefined {
  const explicit = process.env[explicitEnv]?.trim();
  if (explicit) {
    return explicit;
  }
  const base = process.env.OPS_WORKER_BASE_URL?.trim();
  if (base) {
    try {
      const url = new URL(base);
      url.pathname = targetPath;
      url.search = "";
      return url.toString();
    } catch {
      return undefined;
    }
  }
  const legacyWorkerUrl = process.env.MESSENGER_WORKER_URL?.trim();
  if (!legacyWorkerUrl) {
    return undefined;
  }
  try {
    const url = new URL(legacyWorkerUrl);
    const swappedPathname = url.pathname.replace(/\/webhooks\/messenger\/worker\/?$/, targetPath);
    if (swappedPathname === url.pathname) {
      console.error(
        `[${label}] MESSENGER_WORKER_URL path did not match the expected /webhooks/messenger/worker suffix; set ${explicitEnv} or OPS_WORKER_BASE_URL explicitly.`,
      );
      return undefined;
    }
    url.pathname = swappedPathname;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function resolveDeliverySyncWorkerUrl(): string | undefined {
  return resolveWorkerUrl("DELIVERY_SYNC_WORKER_URL", "/webhooks/delivery-sync/worker", "delivery-sync");
}

export function resolveBulkActionWorkerUrl(): string | undefined {
  return resolveWorkerUrl("BULK_ACTION_WORKER_URL", "/webhooks/bulk-action/worker", "bulk-jobs");
}

export interface EnqueueBulkActionTaskInput {
  jobId: string;
}

export async function enqueueBulkActionTask({
  jobId,
}: EnqueueBulkActionTaskInput): Promise<EnqueueTaskResult> {
  const workerUrl = resolveBulkActionWorkerUrl();
  const secret = resolveOpsWorkerSecret();
  const queuePath = resolveOpsQueuePath();
  if (!workerUrl || !secret || !queuePath) {
    return { ok: false, error: OPS_QUEUE_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }
  return postCloudTask(JSON.stringify({ bulkActionJobId: jobId }), { queuePath, workerUrl, secret });
}

export interface EnqueueDeliverySyncTaskInput {
  taskId: string;
}

export async function enqueueDeliverySyncTask({
  taskId,
}: EnqueueDeliverySyncTaskInput): Promise<EnqueueTaskResult> {
  const workerUrl = resolveDeliverySyncWorkerUrl();
  const secret = resolveOpsWorkerSecret();
  const queuePath = resolveOpsQueuePath();
  if (!workerUrl || !secret || !queuePath) {
    return { ok: false, error: OPS_QUEUE_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }
  return postCloudTask(JSON.stringify({ deliverySyncTaskId: taskId }), { queuePath, workerUrl, secret });
}
