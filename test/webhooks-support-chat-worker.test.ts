import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Worker-route tests for the support chat backend, mirroring
// test/webhooks-messenger-worker.test.ts: same HMAC scheme, same Cloud Tasks
// status contract (200 = done/unretryable, 503 = retry). Every service seam is
// mocked so this runs in plain node with no DB / LLM / Cloud Tasks.

const {
  getJobMock,
  completeJobMock,
  failJobMock,
  loadHistoryMock,
  runAgentTurnMock,
} = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  completeJobMock: vi.fn(),
  failJobMock: vi.fn(),
  loadHistoryMock: vi.fn(),
  runAgentTurnMock: vi.fn(),
}));

vi.mock("../app/services/support-chat.server", () => ({
  getSupportChatJob: getJobMock,
  completeSupportChatJob: completeJobMock,
  failSupportChatJob: failJobMock,
  loadSupportChatHistory: loadHistoryMock,
}));

vi.mock("../app/services/agent-core.server", () => ({
  runAgentTurn: runAgentTurnMock,
  CUSTOMER_ACCOUNT_CAPABILITIES: Object.freeze({
    markdown: true,
    carousel: false,
    quickReplies: true,
    productCards: true,
    textLimit: 4000,
    ordering: false,
  }),
}));

import { action } from "../app/routes/webhooks.support-chat_.worker";

const WORKER_SECRET = "worker-signing-secret";
const ROUTE_URL = "https://app.example.com/webhooks/support-chat/worker";
const JOB_ID = "job-1";
const THREAD_ID = "gid://shopify/Customer/1001";

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

function customerTurn(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_WORKER_SECRET", WORKER_SECRET);
  getJobMock.mockResolvedValue({
    id: JOB_ID,
    threadId: THREAD_ID,
    status: "pending",
    blocksJson: null,
    error: null,
  });
  loadHistoryMock.mockResolvedValue([customerTurn("magkano po delivery sa Makati?")]);
  completeJobMock.mockResolvedValue(undefined);
  failJobMock.mockResolvedValue(undefined);
  runAgentTurnMock.mockResolvedValue({
    ok: true,
    reply: { blocks: [{ type: "text", text: "Around P250 po." }] },
    toolsUsed: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("webhooks.support-chat_.worker action — auth + status contract", () => {
  it("rejects non-POST methods with 405", async () => {
    const res = await callAction(new Request(ROUTE_URL, { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }, { signature: null }));
    expect(res.status).toBe(401);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong-secret signature with 401", async () => {
    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }, { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("skips a job that is no longer pending (zero-duplicate guarantee)", async () => {
    getJobMock.mockResolvedValue({
      id: JOB_ID,
      threadId: THREAD_ID,
      status: "done",
      blocksJson: "[]",
      error: null,
    });
    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("runs the turn and completes the job on the happy path", async () => {
    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(completeJobMock).toHaveBeenCalledWith(JOB_ID, THREAD_ID, [
      { type: "text", text: "Around P250 po." },
    ]);
  });

  it("returns 503 on a transient turn failure so Cloud Tasks retries", async () => {
    runAgentTurnMock.mockResolvedValue({ ok: false, error: "upstream 529" });
    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));
    expect(res.status).toBe(503);
    expect(completeJobMock).not.toHaveBeenCalled();
  });
});

// Ordering is Messenger-only in v1. A CONFIRM_ORDER_ / EDIT_ORDER payload is an
// order-commitment affordance with no deterministic handler on this surface, so
// it must never be handed to the LLM as ordinary text.
describe("webhooks.support-chat_.worker action — order-commitment guard", () => {
  const blockedPayloads = [
    "CONFIRM_ORDER_b3f1c0de",
    "[TAP] CONFIRM_ORDER_b3f1c0de",
    "  confirm_order_b3f1c0de",
    "EDIT_ORDER",
    "[TAP] EDIT_ORDER",
  ];

  for (const payload of blockedPayloads) {
    it(`never reaches runAgentTurn for ${JSON.stringify(payload)}`, async () => {
      loadHistoryMock.mockResolvedValue([customerTurn(payload)]);

      const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));

      expect(res.status).toBe(200);
      expect(runAgentTurnMock).not.toHaveBeenCalled();
      expect(completeJobMock).toHaveBeenCalledTimes(1);
      const blocks = completeJobMock.mock.calls[0][2] as Array<{ type: string; text: string }>;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].text).toContain("https://flowercart.store");
      expect(blocks[0].text).toContain("Messenger");
    });
  }

  it("only guards the LATEST customer turn, not an older one", async () => {
    loadHistoryMock.mockResolvedValue([
      customerTurn("CONFIRM_ORDER_old"),
      { role: "assistant", content: [{ type: "text", text: "Hindi po pwede dito." }] },
      customerTurn("sige, magkano po ang sunflower?"),
    ]);

    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));

    expect(res.status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it("lets an ordinary message that merely MENTIONS confirm through", async () => {
    loadHistoryMock.mockResolvedValue([customerTurn("pwede ko na po ba i-confirm ang order ko?")]);

    const res = await callAction(makeTaskRequest({ jobId: JOB_ID }));

    expect(res.status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
  });
});
