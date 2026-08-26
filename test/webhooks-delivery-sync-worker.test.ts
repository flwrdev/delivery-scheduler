import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Worker-route tests for the delivery-sync queue (ADR-22 Phase A), mirroring
// test/webhooks-support-chat-worker.test.ts: same HMAC scheme, same Cloud
// Tasks status contract (200 = done/unretryable, 503 = retry). The secret
// resolver (OPS_WORKER_SECRET with MESSENGER_WORKER_SECRET fallback) is the
// REAL one — its precedence is part of what these tests pin.

const { processMock } = vi.hoisted(() => ({ processMock: vi.fn() }));

vi.mock("../app/services/delivery-sync-task.server", () => ({
  processDeliverySyncTask: processMock,
}));

import { action } from "../app/routes/webhooks.delivery-sync_.worker";

const OPS_SECRET = "ops-signing-secret";
const MESSENGER_SECRET = "messenger-signing-secret";
const ROUTE_URL = "https://app.example.com/webhooks/delivery-sync/worker";
const TASK_ID = "task-1";

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function makeTaskRequest(
  payload: unknown,
  { secret = OPS_SECRET, signature }: { secret?: string; signature?: string | null } = {},
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPS_WORKER_SECRET", OPS_SECRET);
  vi.stubEnv("MESSENGER_WORKER_SECRET", MESSENGER_SECRET);
  processMock.mockResolvedValue({ status: "done" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("webhooks.delivery-sync_.worker auth", () => {
  it("rejects non-POST", async () => {
    const res = await callAction(new Request(ROUTE_URL, { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("401s when no secret is configured at all", async () => {
    vi.stubEnv("OPS_WORKER_SECRET", "");
    vi.stubEnv("MESSENGER_WORKER_SECRET", "");
    const res = await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }));
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("401s a missing or invalid signature", async () => {
    expect(
      (await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }, { signature: null }))).status,
    ).toBe(401);
    expect(
      (await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }, { signature: "sha256=bad" }))).status,
    ).toBe(401);
  });

  it("OPS_WORKER_SECRET wins over the Messenger secret when both are set", async () => {
    expect(
      (await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }, { secret: OPS_SECRET }))).status,
    ).toBe(200);
    expect(
      (await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }, { secret: MESSENGER_SECRET }))).status,
    ).toBe(401);
  });

  it("falls back to MESSENGER_WORKER_SECRET when no ops secret is set", async () => {
    vi.stubEnv("OPS_WORKER_SECRET", "");
    const res = await callAction(
      makeTaskRequest({ deliverySyncTaskId: TASK_ID }, { secret: MESSENGER_SECRET }),
    );
    expect(res.status).toBe(200);
  });
});

describe("webhooks.delivery-sync_.worker payload handling", () => {
  it("200s malformed JSON and a missing task id without processing", async () => {
    expect((await callAction(makeTaskRequest("not json"))).status).toBe(200);
    expect((await callAction(makeTaskRequest({ nope: true }))).status).toBe(200);
    expect((await callAction(makeTaskRequest({ deliverySyncTaskId: 42 }))).status).toBe(200);
    expect(processMock).not.toHaveBeenCalled();
  });
});

describe("webhooks.delivery-sync_.worker Cloud Tasks status contract", () => {
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ status: "done" }, 200],
    [{ status: "terminal" }, 200],
    [{ status: "not_found" }, 200],
    [{ status: "locked" }, 200], // another worker holds the lease — never re-run
    [{ status: "failed", error: "cap" }, 200], // permanent — retrying can't help
    [{ status: "retry", error: "transient" }, 503],
  ];

  it.each(cases)("maps %o to HTTP %i", async (result, expected) => {
    processMock.mockResolvedValue(result);
    const res = await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }));
    expect(res.status).toBe(expected);
    expect(processMock).toHaveBeenCalledWith(TASK_ID);
  });

  it("503s when processing throws (transient by definition)", async () => {
    processMock.mockRejectedValue(new Error("neon dropped"));
    const res = await callAction(makeTaskRequest({ deliverySyncTaskId: TASK_ID }));
    expect(res.status).toBe(503);
  });
});
