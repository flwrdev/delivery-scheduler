import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loader/action tests only, mirroring the style of
// test/webhooks-messenger-route.test.ts and test/app-messenger-orders-route.test.ts:
// authenticate.public.customerAccount and every service call are mocked so
// this suite runs in plain node with no real DB/LLM/Cloud Tasks.

const {
  customerAccountMock,
  ensureThreadMock,
  recordCustomerTurnMock,
  createJobMock,
  getJobMock,
  completeJobMock,
  failJobMock,
  skipJobMock,
  loadHistoryMock,
  enqueueMock,
  runAgentTurnMock,
} = vi.hoisted(() => ({
  customerAccountMock: vi.fn(),
  ensureThreadMock: vi.fn(),
  recordCustomerTurnMock: vi.fn(),
  createJobMock: vi.fn(),
  getJobMock: vi.fn(),
  completeJobMock: vi.fn(),
  failJobMock: vi.fn(),
  skipJobMock: vi.fn(),
  loadHistoryMock: vi.fn(),
  enqueueMock: vi.fn(),
  runAgentTurnMock: vi.fn(),
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { public: { customerAccount: customerAccountMock } },
}));

vi.mock("../app/services/support-chat.server", () => ({
  ensureSupportChatThread: ensureThreadMock,
  recordCustomerTurn: recordCustomerTurnMock,
  createSupportChatJob: createJobMock,
  getSupportChatJob: getJobMock,
  completeSupportChatJob: completeJobMock,
  failSupportChatJob: failJobMock,
  skipSupportChatJob: skipJobMock,
  loadSupportChatHistory: loadHistoryMock,
}));

vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueSupportChatTask: enqueueMock,
}));

vi.mock("../app/services/agent-core.server", () => ({
  runAgentTurn: runAgentTurnMock,
  CUSTOMER_ACCOUNT_CAPABILITIES: Object.freeze({
    markdown: true,
    carousel: false,
    quickReplies: true,
    productCards: true,
    textLimit: 4000,
  }),
}));

import { action as postAction, loader as postLoader } from "../app/routes/api.support-chat";
import { loader as pollLoader } from "../app/routes/api.support-chat_.$jobId";

const ROUTE_URL = "https://app.example.com/api/support-chat";
const SHOP = "hsrwva-nr.myshopify.com";
const CUSTOMER_GID = "gid://shopify/Customer/1001";

function identityCors(response: Response): Response {
  return response;
}

function authOk(overrides: { sub?: string | null; dest?: string } = {}) {
  customerAccountMock.mockResolvedValue({
    cors: identityCors,
    sessionToken: {
      sub: overrides.sub === undefined ? CUSTOMER_GID : overrides.sub,
      dest: overrides.dest === undefined ? `https://${SHOP}` : overrides.dest,
    },
  });
}

function makePostRequest(body: unknown): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as Response).json()) as Record<string, unknown>;
}

// The inline fallback re-loads the transcript it just appended to, so a
// realistic default history ends on the customer's turn.
function customerTurn(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantTurn(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.stubEnv("MESSENGER_SHOP", SHOP);
  customerAccountMock.mockReset();
  ensureThreadMock.mockReset();
  recordCustomerTurnMock.mockReset();
  createJobMock.mockReset();
  getJobMock.mockReset();
  completeJobMock.mockReset();
  failJobMock.mockReset();
  skipJobMock.mockReset();
  loadHistoryMock.mockReset();
  enqueueMock.mockReset();
  runAgentTurnMock.mockReset();

  ensureThreadMock.mockResolvedValue(undefined);
  recordCustomerTurnMock.mockResolvedValue(undefined);
  createJobMock.mockResolvedValue({ jobId: "job-1" });
  completeJobMock.mockResolvedValue(undefined);
  failJobMock.mockResolvedValue(undefined);
  skipJobMock.mockResolvedValue(undefined);
  loadHistoryMock.mockResolvedValue([customerTurn("hi")]);
  enqueueMock.mockResolvedValue({ ok: true, taskName: "projects/p/locations/l/queues/q/tasks/t" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("api.support-chat loader (CORS preflight)", () => {
  it("authenticates the request and returns null", async () => {
    authOk();
    const result = await postLoader({
      request: new Request(ROUTE_URL, { method: "OPTIONS" }),
      params: {},
      context: {},
    } as never);
    expect(customerAccountMock).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe("api.support-chat action (POST)", () => {
  it("returns ok:false not_signed_in when sessionToken.sub is missing", async () => {
    authOk({ sub: null });
    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    expect((res as Response).status).toBe(200);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "not_signed_in" });
    expect(ensureThreadMock).not.toHaveBeenCalled();
  });

  it("rejects a session token whose dest does not match MESSENGER_SHOP", async () => {
    authOk({ dest: "https://some-other-shop.myshopify.com" });
    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);
    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: false, reason: "shop_mismatch" });
    expect(ensureThreadMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("happy path: records the turn, mints a jobId, enqueues, and returns ok:true", async () => {
    authOk();
    const res = await postAction({
      request: makePostRequest({ message: "Hi, may bouquet ba kayo under 1000?" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);
    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: true, jobId: "job-1" });
    expect(ensureThreadMock).toHaveBeenCalledWith({ customerGid: CUSTOMER_GID, shop: SHOP });
    expect(recordCustomerTurnMock).toHaveBeenCalledWith(
      CUSTOMER_GID,
      "Hi, may bouquet ba kayo under 1000?",
    );
    expect(createJobMock).toHaveBeenCalledWith(CUSTOMER_GID);
    expect(enqueueMock).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("rejects an empty message without touching the database", async () => {
    authOk();
    const res = await postAction({
      request: makePostRequest({ message: "   " }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "empty_message" });
    expect(ensureThreadMock).not.toHaveBeenCalled();
  });

  it("processes inline when the queue is not configured (local dev fallback)", async () => {
    authOk();
    enqueueMock.mockResolvedValue({
      ok: false,
      notConfigured: true,
      error: "Messenger queue is not configured on this environment.",
    });
    runAgentTurnMock.mockResolvedValue({
      ok: true,
      reply: { blocks: [{ type: "text", text: "Sure po!" }] },
      toolsUsed: [],
    });

    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);

    expect(json).toEqual({ ok: true, jobId: "job-1" });
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(completeJobMock).toHaveBeenCalledWith("job-1", CUSTOMER_GID, [
      { type: "text", text: "Sure po!" },
    ]);
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it("marks the job failed inline when the LLM is not configured, still answers ok:true jobId", async () => {
    authOk();
    enqueueMock.mockResolvedValue({ ok: false, notConfigured: true, error: "not configured" });
    runAgentTurnMock.mockResolvedValue({
      ok: false,
      error: "Support chat LLM is not configured on this environment.",
      notConfigured: true,
    });

    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);

    expect(json).toEqual({ ok: true, jobId: "job-1" });
    expect(failJobMock).toHaveBeenCalledWith(
      "job-1",
      "Support chat LLM is not configured on this environment.",
    );
    expect(completeJobMock).not.toHaveBeenCalled();
  });

  it("returns 200 + ok:false on an upstream enqueue failure — never throws (ADR-11)", async () => {
    authOk();
    enqueueMock.mockResolvedValue({ ok: false, error: "Cloud Tasks 500" });

    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);

    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: false, reason: "enqueue_failed" });
    expect(failJobMock).toHaveBeenCalledWith("job-1", "Cloud Tasks 500");
  });

  it("returns 200 + ok:false when an unexpected error is thrown mid-action — never a 5xx", async () => {
    authOk();
    recordCustomerTurnMock.mockRejectedValue(new Error("db down"));

    const res = await postAction({
      request: makePostRequest({ message: "hi" }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);

    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: false, reason: "internal_error" });
  });

  it("returns 200 + ok:false for an unparsable JSON body", async () => {
    authOk();
    const res = await postAction({
      request: new Request(ROUTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
      params: {},
      context: {},
    } as never);
    const json = await readJson(res);
    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: false, reason: "invalid_body" });
  });
});

// The inline fallback (local dev, no Cloud Tasks) runs the SAME shared turn the
// worker runs — support-chat-turn.server.ts. Both pre-LLM guards must therefore
// fire on this path too; they used to cover the worker only.
describe("api.support-chat action (POST) — inline fallback shares the worker's guards", () => {
  function inlineDev() {
    authOk();
    enqueueMock.mockResolvedValue({
      ok: false,
      notConfigured: true,
      error: "Messenger queue is not configured on this environment.",
    });
    runAgentTurnMock.mockResolvedValue({
      ok: true,
      reply: { blocks: [{ type: "text", text: "Sure po!" }] },
      toolsUsed: [],
    });
  }

  async function postInline(message: string) {
    return postAction({
      request: makePostRequest({ message }),
      params: {},
      context: {},
    } as never);
  }

  const blockedPayloads = [
    "CONFIRM_ORDER_b3f1c0de",
    "[TAP] CONFIRM_ORDER_b3f1c0de",
    "  confirm_order_b3f1c0de",
    "EDIT_ORDER",
  ];

  for (const payload of blockedPayloads) {
    it(`intercepts ${JSON.stringify(payload)} before the LLM on the inline path`, async () => {
      inlineDev();
      loadHistoryMock.mockResolvedValue([customerTurn(payload)]);

      const res = await postInline(payload);
      const json = await readJson(res);

      expect((res as Response).status).toBe(200);
      expect(json).toEqual({ ok: true, jobId: "job-1" });
      expect(runAgentTurnMock).not.toHaveBeenCalled();
      expect(completeJobMock).toHaveBeenCalledTimes(1);
      const blocks = completeJobMock.mock.calls[0][2] as Array<{ type: string; text: string }>;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].text).toContain("https://flowercart.store");
      expect(blocks[0].text).toContain("Messenger");
      expect(failJobMock).not.toHaveBeenCalled();
    });
  }

  it("does not call runAgentTurn inline when the history ends on an assistant turn", async () => {
    inlineDev();
    loadHistoryMock.mockResolvedValue([customerTurn("hi po"), assistantTurn("Kumusta po!")]);

    const res = await postInline("hi po");
    const json = await readJson(res);

    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: true, jobId: "job-1" });
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
    expect(skipJobMock).toHaveBeenCalledWith("job-1");
  });

  it("does not call runAgentTurn inline on an empty history", async () => {
    inlineDev();
    loadHistoryMock.mockResolvedValue([]);

    const res = await postInline("hi po");

    expect((res as Response).status).toBe(200);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
    expect(skipJobMock).toHaveBeenCalledWith("job-1");
  });

  it("lets an ordinary message through inline, guards and all", async () => {
    inlineDev();
    loadHistoryMock.mockResolvedValue([customerTurn("pwede ko na po ba i-confirm ang order ko?")]);

    const res = await postInline("pwede ko na po ba i-confirm ang order ko?");

    expect((res as Response).status).toBe(200);
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(skipJobMock).not.toHaveBeenCalled();
    expect(completeJobMock).toHaveBeenCalledWith("job-1", CUSTOMER_GID, [
      { type: "text", text: "Sure po!" },
    ]);
  });
});

describe("api.support-chat.$jobId loader (poll)", () => {
  function pollRequest(): Request {
    return new Request(`${ROUTE_URL}/job-1`, { method: "GET" });
  }

  it("returns ok:false not_signed_in when sessionToken.sub is missing", async () => {
    authOk({ sub: null });
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "not_signed_in" });
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("rejects a dest mismatch", async () => {
    authOk({ dest: "https://some-other-shop.myshopify.com" });
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "shop_mismatch" });
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("returns status pending while the job is still running", async () => {
    authOk();
    getJobMock.mockResolvedValue({
      id: "job-1",
      threadId: CUSTOMER_GID,
      status: "pending",
      blocksJson: null,
      error: null,
    });
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: true, status: "pending" });
  });

  it("returns status done with blocks once the job finishes", async () => {
    authOk();
    getJobMock.mockResolvedValue({
      id: "job-1",
      threadId: CUSTOMER_GID,
      status: "done",
      blocksJson: JSON.stringify([{ type: "text", text: "Sige po!" }]),
      error: null,
    });
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: true, status: "done", blocks: [{ type: "text", text: "Sige po!" }] });
  });

  it("never leaks another customer's job — returns not_found", async () => {
    authOk();
    getJobMock.mockResolvedValue({
      id: "job-1",
      threadId: "gid://shopify/Customer/999",
      status: "done",
      blocksJson: JSON.stringify([{ type: "text", text: "secret" }]),
      error: null,
    });
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found for a job that does not exist", async () => {
    authOk();
    getJobMock.mockResolvedValue(null);
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "does-not-exist" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect(json).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns 200 + ok:false when the lookup throws — never a 5xx", async () => {
    authOk();
    getJobMock.mockRejectedValue(new Error("db down"));
    const res = await pollLoader({
      request: pollRequest(),
      params: { jobId: "job-1" },
      context: {},
    } as never);
    const json = await readJson(res);
    expect((res as Response).status).toBe(200);
    expect(json).toEqual({ ok: false, reason: "internal_error" });
  });
});
