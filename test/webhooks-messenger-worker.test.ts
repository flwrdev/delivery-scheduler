import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { processMock } = vi.hoisted(() => ({
  processMock: vi.fn(),
}));

vi.mock("../app/services/messenger-events.server", () => ({
  processEchoByMid: processMock,
}));

import { action } from "../app/routes/webhooks.messenger_.worker";

const WORKER_SECRET = "worker-signing-secret";
const ROUTE_URL = "https://app.example.com/webhooks/messenger/worker";

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function makeTaskRequest(
  payload: unknown,
  { secret = WORKER_SECRET, signature }: { secret?: string; signature?: string | null } = {},
): Request {
  const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "Content-Type": "application/json" });
  const resolved = signature === undefined ? signBody(rawBody, secret) : signature;
  if (resolved !== null) {
    headers.set("X-Messenger-Worker-Signature", resolved);
  }
  return new Request(ROUTE_URL, { method: "POST", headers, body: rawBody });
}

async function callAction(request: Request): Promise<Response> {
  return (await action({ request, params: {}, context: {} } as never)) as Response;
}

describe("webhooks.messenger_.worker action", () => {
  beforeEach(() => {
    vi.stubEnv("MESSENGER_WORKER_SECRET", WORKER_SECRET);
    processMock.mockResolvedValue({ status: "sent", replyMid: "mid.bot.1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects non-POST methods with 405", async () => {
    const res = await callAction(new Request(ROUTE_URL, { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    const res = await callAction(makeTaskRequest({ mid: "m1" }, { signature: null }));
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong-secret signature with 401", async () => {
    const res = await callAction(makeTaskRequest({ mid: "m1" }, { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects when MESSENGER_WORKER_SECRET is not configured", async () => {
    vi.unstubAllEnvs();
    const res = await callAction(makeTaskRequest({ mid: "m1" }));
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("returns 200 for malformed JSON with a valid signature (retry cannot fix it)", async () => {
    const res = await callAction(makeTaskRequest("{not json"));
    expect(res.status).toBe(200);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("returns 200 when the payload has no mid", async () => {
    const res = await callAction(makeTaskRequest({ nope: true }));
    expect(res.status).toBe(200);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("processes the mid and returns 200 on sent", async () => {
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(processMock).toHaveBeenCalledWith("mid.abc");
  });

  it("returns 200 on skipped (already replied — the zero-duplicate guarantee)", async () => {
    processMock.mockResolvedValue({ status: "skipped" });
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 on not_found (retrying cannot materialize the row)", async () => {
    processMock.mockResolvedValue({ status: "not_found" });
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 on not_configured (retry storm prevention)", async () => {
    processMock.mockResolvedValue({ status: "not_configured" });
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(200);
  });

  it("returns 503 on retryable_failure so Cloud Tasks retries", async () => {
    processMock.mockResolvedValue({ status: "retryable_failure" });
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(503);
  });

  it("returns 503 when processing throws", async () => {
    processMock.mockRejectedValue(new Error("unexpected"));
    const res = await callAction(makeTaskRequest({ mid: "mid.abc" }));
    expect(res.status).toBe(503);
  });
});
