import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPS_QUEUE_NOT_CONFIGURED_MESSAGE,
  OPS_WORKER_SIGNATURE_HEADER,
  enqueueBulkActionTask,
  enqueueDeliverySyncTask,
  resolveBulkActionWorkerUrl,
  resolveDeliverySyncWorkerUrl,
  resolveOpsQueuePath,
  resolveOpsWorkerSecret,
} from "../app/services/ops-queue.server";

const QUEUE_PATH = "projects/p/locations/us-central1/queues/ops";
const LEGACY_WORKER_URL = "https://app.example.com/webhooks/messenger/worker";
const SECRET = "ops-signing-secret";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubLegacyEnv() {
  vi.stubEnv("MESSENGER_TASKS_QUEUE_PATH", QUEUE_PATH);
  vi.stubEnv("MESSENGER_WORKER_URL", LEGACY_WORKER_URL);
  vi.stubEnv("MESSENGER_WORKER_SECRET", SECRET);
}

describe("env resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers OPS_* over the legacy MESSENGER_* names", () => {
    stubLegacyEnv();
    vi.stubEnv("OPS_WORKER_SECRET", "ops-secret");
    vi.stubEnv("OPS_TASKS_QUEUE_PATH", "projects/p/locations/l/queues/q2");
    expect(resolveOpsWorkerSecret()).toBe("ops-secret");
    expect(resolveOpsQueuePath()).toBe("projects/p/locations/l/queues/q2");
  });

  it("falls back to the legacy names when OPS_* are unset", () => {
    stubLegacyEnv();
    expect(resolveOpsWorkerSecret()).toBe(SECRET);
    expect(resolveOpsQueuePath()).toBe(QUEUE_PATH);
  });

  it("derives worker URLs from OPS_WORKER_BASE_URL when set", () => {
    vi.stubEnv("OPS_WORKER_BASE_URL", "https://ops.example.com/anything?x=1");
    expect(resolveDeliverySyncWorkerUrl()).toBe("https://ops.example.com/webhooks/delivery-sync/worker");
    expect(resolveBulkActionWorkerUrl()).toBe("https://ops.example.com/webhooks/bulk-action/worker");
  });

  it("derives worker URLs from the legacy MESSENGER_WORKER_URL by path swap", () => {
    stubLegacyEnv();
    expect(resolveDeliverySyncWorkerUrl()).toBe("https://app.example.com/webhooks/delivery-sync/worker");
    expect(resolveBulkActionWorkerUrl()).toBe("https://app.example.com/webhooks/bulk-action/worker");
  });

  it("explicit per-worker env wins over every derivation", () => {
    stubLegacyEnv();
    vi.stubEnv("OPS_WORKER_BASE_URL", "https://ops.example.com");
    vi.stubEnv("DELIVERY_SYNC_WORKER_URL", "https://explicit.example.com/ds");
    expect(resolveDeliverySyncWorkerUrl()).toBe("https://explicit.example.com/ds");
  });

  it("returns undefined and logs when the legacy URL has an unexpected path", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("MESSENGER_WORKER_URL", "https://app.example.com/webhooks/other");
    expect(resolveDeliverySyncWorkerUrl()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("enqueueDeliverySyncTask / enqueueBulkActionTask", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns notConfigured without a network call when nothing is set", async () => {
    const result = await enqueueDeliverySyncTask({ taskId: "t1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
      expect(result.error).toBe(OPS_QUEUE_NOT_CONFIGURED_MESSAGE);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a signed task addressed to the delivery-sync worker", async () => {
    stubLegacyEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/ds-1` });
    });

    const result = await enqueueDeliverySyncTask({ taskId: "task-9" });
    expect(result).toEqual({ ok: true, taskName: `${QUEUE_PATH}/tasks/ds-1` });

    const [tasksUrl, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(tasksUrl)).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE_PATH}/tasks`);
    const body = JSON.parse(String(tasksInit.body)) as {
      task: { httpRequest: { url: string; headers: Record<string, string>; body: string } };
    };
    expect(body.task.httpRequest.url).toBe("https://app.example.com/webhooks/delivery-sync/worker");
    const decoded = Buffer.from(body.task.httpRequest.body, "base64").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ deliverySyncTaskId: "task-9" });
    const expected = `sha256=${crypto.createHmac("sha256", SECRET).update(decoded, "utf8").digest("hex")}`;
    expect(body.task.httpRequest.headers[OPS_WORKER_SIGNATURE_HEADER]).toBe(expected);
  });

  it("creates a bulk-action task with the bulkActionJobId payload", async () => {
    stubLegacyEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/ba-1` });
    });

    const result = await enqueueBulkActionTask({ jobId: "job-3" });
    expect(result.ok).toBe(true);
    const [, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(tasksInit.body)) as {
      task: { httpRequest: { url: string; body: string } };
    };
    expect(body.task.httpRequest.url).toBe("https://app.example.com/webhooks/bulk-action/worker");
    const decoded = Buffer.from(body.task.httpRequest.body, "base64").toString("utf8");
    expect(JSON.parse(decoded)).toEqual({ bulkActionJobId: "job-3" });
  });

  it("returns ok:false with the status when Cloud Tasks rejects", async () => {
    stubLegacyEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ error: { message: "queue not found" } }, 404);
    });

    const result = await enqueueDeliverySyncTask({ taskId: "t1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
      expect(result.notConfigured).toBeFalsy();
    }
  });

  it("never throws on a network rejection", async () => {
    stubLegacyEnv();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await enqueueBulkActionTask({ jobId: "j" });
    expect(result.ok).toBe(false);
  });
});
