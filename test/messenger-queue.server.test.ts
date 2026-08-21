import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enqueueMessengerEchoTask,
  enqueueMessengerFollowUpTask,
  enqueueSupportChatTask,
  MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE,
} from "../app/services/messenger-queue.server";

const QUEUE_PATH = "projects/lalamove-map/locations/us-central1/queues/messenger-events";
const WORKER_URL = "https://app.example.com/webhooks/messenger/worker";
const WORKER_SECRET = "worker-signing-secret";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function stubConfiguredEnv() {
  vi.stubEnv("MESSENGER_TASKS_QUEUE_PATH", QUEUE_PATH);
  vi.stubEnv("MESSENGER_WORKER_URL", WORKER_URL);
  vi.stubEnv("MESSENGER_WORKER_SECRET", WORKER_SECRET);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("enqueueMessengerEchoTask", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns notConfigured without any network call when env vars are missing", async () => {
    const result = await enqueueMessengerEchoTask({ mid: "m1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
      expect(result.error).toBe(MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a Cloud Task with a signed base64 payload on success", async () => {
    stubConfiguredEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token", expires_in: 3599 });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/task-123` });
    });

    const result = await enqueueMessengerEchoTask({ mid: "mid.abc" });

    expect(result).toEqual({ ok: true, taskName: `${QUEUE_PATH}/tasks/task-123` });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: metadata server token fetch with the required header.
    const [metadataUrl, metadataInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(metadataUrl)).toBe(METADATA_TOKEN_URL);
    expect(new Headers(metadataInit.headers).get("Metadata-Flavor")).toBe("Google");

    // Second call: Cloud Tasks createTask.
    const [tasksUrl, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(tasksUrl)).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE_PATH}/tasks`);
    expect(new Headers(tasksInit.headers).get("Authorization")).toBe("Bearer oauth-token");

    const requestBody = JSON.parse(String(tasksInit.body)) as {
      task: {
        httpRequest: {
          url: string;
          httpMethod: string;
          headers: Record<string, string>;
          body: string;
        };
        dispatchDeadline?: string;
      };
    };
    expect(requestBody.task.httpRequest.url).toBe(WORKER_URL);
    expect(requestBody.task.httpRequest.httpMethod).toBe("POST");

    const decodedPayload = Buffer.from(requestBody.task.httpRequest.body, "base64").toString("utf8");
    expect(JSON.parse(decodedPayload)).toEqual({ mid: "mid.abc" });

    const expectedSignature = `sha256=${crypto
      .createHmac("sha256", WORKER_SECRET)
      .update(decodedPayload, "utf8")
      .digest("hex")}`;
    expect(requestBody.task.httpRequest.headers["X-Messenger-Worker-Signature"]).toBe(
      expectedSignature,
    );
  });

  it("returns ok:false when the metadata token fetch fails", async () => {
    stubConfiguredEnv();
    fetchMock.mockResolvedValueOnce(new Response("no token", { status: 500 }));

    const result = await enqueueMessengerEchoTask({ mid: "m1" });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false with the status when the Cloud Tasks API rejects", async () => {
    stubConfiguredEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ error: { message: "queue not found" } }, 404);
    });

    const result = await enqueueMessengerEchoTask({ mid: "m1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("404");
      expect(result.notConfigured).toBeFalsy();
    }
  });

  it("never throws on a network rejection", async () => {
    stubConfiguredEnv();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await enqueueMessengerEchoTask({ mid: "m1" });
    expect(result.ok).toBe(false);
  });

  it("trims trailing whitespace from stdin-pasted env values", async () => {
    vi.stubEnv("MESSENGER_TASKS_QUEUE_PATH", `${QUEUE_PATH}\n`);
    vi.stubEnv("MESSENGER_WORKER_URL", `${WORKER_URL}\n`);
    vi.stubEnv("MESSENGER_WORKER_SECRET", `${WORKER_SECRET}\n`);
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/t1` });
    });

    const result = await enqueueMessengerEchoTask({ mid: "m1" });
    expect(result.ok).toBe(true);

    const [tasksUrl, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(tasksUrl)).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE_PATH}/tasks`);
    const requestBody = JSON.parse(String(tasksInit.body)) as {
      task: { httpRequest: { url: string; headers: Record<string, string>; body: string } };
    };
    expect(requestBody.task.httpRequest.url).toBe(WORKER_URL);
    const decodedPayload = Buffer.from(requestBody.task.httpRequest.body, "base64").toString("utf8");
    const expectedSignature = `sha256=${crypto
      .createHmac("sha256", WORKER_SECRET)
      .update(decodedPayload, "utf8")
      .digest("hex")}`;
    expect(requestBody.task.httpRequest.headers["X-Messenger-Worker-Signature"]).toBe(
      expectedSignature,
    );
  });
});


describe("enqueueMessengerFollowUpTask (delayed abandoned-order reminder)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("creates a task with a followUp payload and a future scheduleTime", async () => {
    stubConfiguredEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/fu-1` });
    });

    const before = Date.now();
    const result = await enqueueMessengerFollowUpTask({
      psid: "psid-9",
      orderKey: "key-9",
      delaySeconds: 3 * 3600,
    });
    expect(result.ok).toBe(true);

    const [, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const requestBody = JSON.parse(String(tasksInit.body)) as {
      task: { httpRequest: { body: string }; scheduleTime?: string };
    };
    const decoded = JSON.parse(
      Buffer.from(requestBody.task.httpRequest.body, "base64").toString("utf8"),
    );
    expect(decoded).toEqual({ followUp: { psid: "psid-9", orderKey: "key-9" } });

    const scheduled = new Date(requestBody.task.scheduleTime ?? 0).getTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + 3 * 3600 * 1000 - 5000);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + 3 * 3600 * 1000 + 5000);
  });

  it("returns notConfigured without any network call when env vars are missing", async () => {
    const result = await enqueueMessengerFollowUpTask({
      psid: "p",
      orderKey: "k",
      delaySeconds: 60,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("enqueueSupportChatTask / resolveSupportChatWorkerUrl", () => {
  const fetchMock = vi.fn();
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    consoleErrorSpy.mockClear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("derives the worker URL from MESSENGER_WORKER_URL by path-swapping when SUPPORT_CHAT_WORKER_URL is unset", async () => {
    stubConfiguredEnv();
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url) === METADATA_TOKEN_URL) {
        return jsonResponse({ access_token: "oauth-token" });
      }
      return jsonResponse({ name: `${QUEUE_PATH}/tasks/sc-1` });
    });

    const result = await enqueueSupportChatTask({ jobId: "job-1" });
    expect(result.ok).toBe(true);

    const [tasksUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(tasksUrl)).toContain(QUEUE_PATH);

    const [, tasksInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const requestBody = JSON.parse(String(tasksInit.body)) as {
      task: { httpRequest: { url: string } };
    };
    expect(requestBody.task.httpRequest.url).toBe("https://app.example.com/webhooks/support-chat/worker");
  });

  it("returns notConfigured (never the unswapped Messenger worker URL) when MESSENGER_WORKER_URL doesn't match the expected path", async () => {
    vi.stubEnv("MESSENGER_TASKS_QUEUE_PATH", QUEUE_PATH);
    vi.stubEnv("MESSENGER_WORKER_URL", "https://app.example.com/webhooks/some-other-worker");
    vi.stubEnv("MESSENGER_WORKER_SECRET", WORKER_SECRET);

    const result = await enqueueSupportChatTask({ jobId: "job-2" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns notConfigured without any network call when env vars are missing", async () => {
    const result = await enqueueSupportChatTask({ jobId: "job-3" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notConfigured).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
