import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /apps/schedule-rules/support-chat — App-Proxy-signed storefront chat
// widget entry point (2026-08-22). Signature verification uses the REAL
// verifyAppProxySignature (not mocked) with hand-signed fixtures, same idiom
// as test/verify-app-proxy.server.test.ts. Every downstream service call is
// mocked, so this suite runs in plain node with no real DB/LLM/Cloud Tasks.

const {
  ensureAnonymousThreadMock,
  recordCustomerTurnMock,
  createJobMock,
  failJobMock,
  enqueueMock,
  runSupportChatTurnMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  ensureAnonymousThreadMock: vi.fn(),
  recordCustomerTurnMock: vi.fn(),
  createJobMock: vi.fn(),
  failJobMock: vi.fn(),
  enqueueMock: vi.fn(),
  runSupportChatTurnMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("../app/services/support-chat.server", () => ({
  ensureAnonymousSupportChatThread: ensureAnonymousThreadMock,
  recordCustomerTurn: recordCustomerTurnMock,
  createSupportChatJob: createJobMock,
  failSupportChatJob: failJobMock,
}));

vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueSupportChatTask: enqueueMock,
}));

vi.mock("../app/services/support-chat-turn.server", () => ({
  runSupportChatTurn: runSupportChatTurnMock,
}));

vi.mock("../app/services/agent-rate-limit.server", () => ({
  checkAndRecordAgentRateLimit: rateLimitMock,
}));

import { action } from "../app/routes/apps.schedule-rules.support-chat";

const SECRET = "hush";
const SHOP = "hsrwva-nr.myshopify.com";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

// Mirrors Shopify's own reference algorithm, same helper as
// test/verify-app-proxy.server.test.ts.
function sign(params: URLSearchParams, secret: string): string {
  const sorted = [...new Set(params.keys())]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

function signedUrl(extraParams: Record<string, string> = {}, { secret = SECRET, shop = SHOP } = {}): string {
  const params = new URLSearchParams({
    shop,
    path_prefix: "/apps/schedule-rules",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extraParams,
  });
  params.set("signature", sign(params, secret));
  return `https://app.example.com/apps/schedule-rules/support-chat?${params.toString()}`;
}

function postRequest(body: unknown, urlOverride?: string): Request {
  return new Request(urlOverride ?? signedUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callAction(request: Request) {
  return (await action({ request, params: {}, context: {} } as never)) as Response;
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_SECRET", SECRET);
  vi.stubEnv("MESSENGER_SHOP", SHOP);

  ensureAnonymousThreadMock.mockReset();
  recordCustomerTurnMock.mockReset();
  createJobMock.mockReset();
  failJobMock.mockReset();
  enqueueMock.mockReset();
  runSupportChatTurnMock.mockReset();
  rateLimitMock.mockReset();

  ensureAnonymousThreadMock.mockResolvedValue(`storefront:${CONVERSATION_ID}`);
  recordCustomerTurnMock.mockResolvedValue(undefined);
  createJobMock.mockResolvedValue({ jobId: "job-1" });
  failJobMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue({ ok: true, taskName: "projects/p/locations/l/queues/q/tasks/t" });
  rateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("apps.schedule-rules.support-chat action — signature + shop verification", () => {
  it("rejects a missing/invalid signature with 401 before touching any service", async () => {
    const url = signedUrl();
    const res = await callAction(
      postRequest({ conversationId: CONVERSATION_ID, message: "hi" }, url.replace(/signature=[0-9a-f]+/, "signature=deadbeef")),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ ok: false, reason: "unauthorized" });
    expect(ensureAnonymousThreadMock).not.toHaveBeenCalled();
  });

  it("rejects a shop that does not match MESSENGER_SHOP with 401", async () => {
    const url = signedUrl({}, { shop: "some-other-shop.myshopify.com" });
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }, url));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ ok: false, reason: "shop_mismatch" });
    expect(ensureAnonymousThreadMock).not.toHaveBeenCalled();
  });
});

describe("apps.schedule-rules.support-chat action — body validation", () => {
  it("rejects an unparsable JSON body with 400", async () => {
    const res = await callAction(
      new Request(signedUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json())).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("rejects a malformed conversationId with 400, without touching rate limiting or the database", async () => {
    const res = await callAction(postRequest({ conversationId: "not-a-uuid", message: "hi" }));
    expect(res.status).toBe(400);
    expect((await res.json())).toEqual({ ok: false, reason: "invalid_conversation_id" });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(ensureAnonymousThreadMock).not.toHaveBeenCalled();
  });

  it("rejects an empty message with 400", async () => {
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "   " }));
    expect(res.status).toBe(400);
    expect((await res.json())).toEqual({ ok: false, reason: "empty_message" });
  });

  it("rejects a message over the 4000-char textLimit with 400", async () => {
    const res = await callAction(
      postRequest({ conversationId: CONVERSATION_ID, message: "a".repeat(4001) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json())).toEqual({ ok: false, reason: "message_too_long" });
  });
});

describe("apps.schedule-rules.support-chat action — rate limiting", () => {
  it("returns 429 when the per-conversation limit trips, without touching the database", async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120 });
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(429);
    expect((await res.json())).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 120 });
    expect(ensureAnonymousThreadMock).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith(`conv:${CONVERSATION_ID}`, 20, 60 * 60_000);
  });

  it("checks the per-IP limit (from X-Forwarded-For) after the per-conversation limit passes", async () => {
    rateLimitMock.mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 }); // conv
    rateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 }); // ip
    const request = postRequest({ conversationId: CONVERSATION_ID, message: "hi" });
    request.headers.set("x-forwarded-for", "203.0.113.7, 10.0.0.1");
    const res = await callAction(request);
    expect(res.status).toBe(429);
    expect((await res.json())).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 30 });
    expect(rateLimitMock).toHaveBeenNthCalledWith(2, "ip:203.0.113.7", 60, 60 * 60_000);
    expect(ensureAnonymousThreadMock).not.toHaveBeenCalled();
  });

  it("skips the IP check gracefully when X-Forwarded-For is absent", async () => {
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(200);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
  });
});

describe("apps.schedule-rules.support-chat action — happy path + enqueue", () => {
  it("ensures the anonymous thread, records the turn, mints a jobId, enqueues, and returns 200", async () => {
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "May bouquet ba under 1000?" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, jobId: "job-1" });
    expect(ensureAnonymousThreadMock).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID, shop: SHOP });
    expect(recordCustomerTurnMock).toHaveBeenCalledWith(`storefront:${CONVERSATION_ID}`, "May bouquet ba under 1000?");
    expect(createJobMock).toHaveBeenCalledWith(`storefront:${CONVERSATION_ID}`);
    expect(enqueueMock).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(runSupportChatTurnMock).not.toHaveBeenCalled();
  });

  it("processes inline when the queue is not configured (local dev fallback), still 200", async () => {
    enqueueMock.mockResolvedValue({ ok: false, notConfigured: true, error: "not configured" });
    runSupportChatTurnMock.mockResolvedValue({ status: "done", intercepted: false });

    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, jobId: "job-1" });
    expect(runSupportChatTurnMock).toHaveBeenCalledWith({
      jobId: "job-1",
      threadId: `storefront:${CONVERSATION_ID}`,
    });
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it("marks the job failed inline on an inline turn failure, still 200 with the jobId", async () => {
    enqueueMock.mockResolvedValue({ ok: false, notConfigured: true, error: "not configured" });
    runSupportChatTurnMock.mockResolvedValue({ status: "failed", error: "LLM down", notConfigured: false });

    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, jobId: "job-1" });
    expect(failJobMock).toHaveBeenCalledWith("job-1", "LLM down");
  });

  it("returns 502 + ok:false on a real upstream enqueue failure", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "Cloud Tasks 500" });
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(502);
    expect((await res.json())).toEqual({ ok: false, reason: "enqueue_failed" });
    expect(failJobMock).toHaveBeenCalledWith("job-1", "Cloud Tasks 500");
  });

  it("returns 502 + ok:false when an unexpected error is thrown mid-action", async () => {
    recordCustomerTurnMock.mockRejectedValue(new Error("db down"));
    const res = await callAction(postRequest({ conversationId: CONVERSATION_ID, message: "hi" }));
    expect(res.status).toBe(502);
    expect((await res.json())).toEqual({ ok: false, reason: "internal_error" });
  });
});
