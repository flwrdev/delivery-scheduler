// Cloud Tasks enqueue for the FlowerCart Messenger agent (phase 3).
//
// Why a real queue: Cloud Run throttles CPU once the webhook's 200 returns, so
// fire-and-forget work dies mid-flight — the master doc mandates Cloud Tasks.
// The webhook records the message in Neon, enqueues { mid }, and acks fast;
// the worker route does the actual send with retries.
//
// Auth model (recorded deviation): tasks carry an HMAC-SHA256 signature over
// the payload (X-Messenger-Worker-Signature, same sha256=<hex> format Meta
// uses) keyed with MESSENGER_WORKER_SECRET, verified by the worker with the
// existing verify-meta-signature lib. Chosen over Cloud Tasks OIDC to keep
// zero new dependencies and reuse an already-tested verifier.
//
// The OAuth token for the Cloud Tasks API itself comes from the Cloud Run
// metadata server (the service account needs roles/cloudtasks.enqueuer).

import crypto from "node:crypto";

export const MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE =
  "Messenger queue is not configured on this environment.";

export const MESSENGER_WORKER_SIGNATURE_HEADER = "X-Messenger-Worker-Signature";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const FETCH_TIMEOUT_MS = 5000;

export interface EnqueueMessengerEchoTaskInput {
  mid: string;
}

export type EnqueueMessengerEchoTaskResult =
  | { ok: true; taskName: string }
  | { ok: false; error: string; notConfigured?: boolean };

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

export async function enqueueMessengerEchoTask({
  mid,
}: EnqueueMessengerEchoTaskInput): Promise<EnqueueMessengerEchoTaskResult> {
  const queuePath = process.env.MESSENGER_TASKS_QUEUE_PATH?.trim();
  const workerUrl = process.env.MESSENGER_WORKER_URL?.trim();
  const workerSecret = process.env.MESSENGER_WORKER_SECRET?.trim();
  if (!queuePath || !workerUrl || !workerSecret) {
    return { ok: false, error: MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE, notConfigured: true };
  }

  try {
    const accessToken = await fetchAccessToken();
    if (!accessToken) {
      return { ok: false, error: "Could not obtain a Cloud Tasks access token." };
    }

    const rawPayload = JSON.stringify({ mid });
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
              [MESSENGER_WORKER_SIGNATURE_HEADER]: signWorkerPayload(rawPayload, workerSecret),
            },
            body: Buffer.from(rawPayload, "utf8").toString("base64"),
          },
          // Bounded so a hung worker attempt fails fast and retries.
          dispatchDeadline: "30s",
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    let payload: { name?: string; error?: { message?: string } } = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — fall through to the status-based error below.
    }

    if (!response.ok) {
      const apiMessage = payload.error?.message ?? "unknown error";
      return { ok: false, error: `Cloud Tasks ${response.status}: ${apiMessage}` };
    }

    return { ok: true, taskName: payload.name ?? "" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to enqueue Messenger task.",
    };
  }
}
