import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Worker-route tests for the bulk-action queue (ADR-22 Phase B), mirroring
// test/webhooks-delivery-sync-worker.test.ts — plus the cooperative-chunking
// contract: "continue" re-enqueues the SAME job and 200s; a failed re-enqueue
// 503s so Cloud Tasks keeps the chain alive.

const { processMock, enqueueMock } = vi.hoisted(() => ({
  processMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock("../app/services/bulk-action-jobs.server", () => ({
  processBulkActionJobChunk: processMock,
}));

vi.mock("../app/services/ops-queue.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/ops-queue.server")>();
  return { ...actual, enqueueBulkActionTask: enqueueMock };
});

import { action } from "../app/routes/webhooks.bulk-action_.worker";

const OPS_SECRET = "ops-signing-secret";
const ROUTE_URL = "https://app.example.com/webhooks/bulk-action/worker";
const JOB_ID = "job-1";

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function makeTaskRequest(
  payload: unknown,
  { signature }: { signature?: string | null } = {},
): Request {
  const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "Content-Type": "application/json" });
  const resolved = signature === undefined ? signBody(rawBody, OPS_SECRET) : signature;
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
  processMock.mockResolvedValue({ status: "done" });
  enqueueMock.mockResolvedValue({ ok: true, taskName: "t" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("webhooks.bulk-action_.worker auth + payload", () => {
  it("rejects non-POST, missing secret, and bad signatures", async () => {
    expect((await callAction(new Request(ROUTE_URL, { method: "GET" }))).status).toBe(405);

    vi.stubEnv("OPS_WORKER_SECRET", "");
    vi.stubEnv("MESSENGER_WORKER_SECRET", "");
    expect((await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }))).status).toBe(401);

    vi.stubEnv("OPS_WORKER_SECRET", OPS_SECRET);
    expect(
      (await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }, { signature: "sha256=bad" }))).status,
    ).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("200s malformed payloads without processing", async () => {
    expect((await callAction(makeTaskRequest("not json"))).status).toBe(200);
    expect((await callAction(makeTaskRequest({ nope: true }))).status).toBe(200);
    expect(processMock).not.toHaveBeenCalled();
  });
});

describe("webhooks.bulk-action_.worker chunking contract", () => {
  it("done → 200, no re-enqueue", async () => {
    processMock.mockResolvedValue({ status: "done" });
    const res = await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("continue → re-enqueues the SAME job and 200s", async () => {
    processMock.mockResolvedValue({ status: "continue", remaining: 42 });
    const res = await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledWith({ jobId: JOB_ID });
  });

  it("continue + re-enqueue failure → 503 so Cloud Tasks keeps the chain alive", async () => {
    processMock.mockResolvedValue({ status: "continue", remaining: 42 });
    enqueueMock.mockResolvedValue({ ok: false, error: "queue down" });
    const res = await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }));
    expect(res.status).toBe(503);
  });

  it.each([
    [{ status: "failed", error: "no session" }, 200],
    [{ status: "locked" }, 200],
    [{ status: "terminal" }, 200],
    [{ status: "not_found" }, 200],
  ])("maps %o to HTTP %i", async (result, expected) => {
    processMock.mockResolvedValue(result);
    const res = await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }));
    expect(res.status).toBe(expected);
  });

  it("503s when processing throws", async () => {
    processMock.mockRejectedValue(new Error("neon dropped"));
    const res = await callAction(makeTaskRequest({ bulkActionJobId: JOB_ID }));
    expect(res.status).toBe(503);
  });
});
