import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /apps/schedule-rules/support-chat/:jobId — App-Proxy-signed poll route
// for the storefront chat widget (2026-08-22). Same signature-fixture idiom
// as test/apps-schedule-rules-support-chat-route.test.ts.

const { getJobMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
}));

vi.mock("../app/services/support-chat.server", () => ({
  getSupportChatJob: getJobMock,
}));

import { loader } from "../app/routes/apps.schedule-rules.support-chat_.$jobId";

const SECRET = "hush";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = `storefront:${CONVERSATION_ID}`;
const JOB_ID = "job-1";

function sign(params: URLSearchParams, secret: string): string {
  const sorted = [...new Set(params.keys())]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

function signedPollUrl(
  extraParams: Record<string, string> = {},
  { secret = SECRET }: { secret?: string } = {},
): string {
  const params = new URLSearchParams({
    shop: "hsrwva-nr.myshopify.com",
    path_prefix: "/apps/schedule-rules",
    timestamp: String(Math.floor(Date.now() / 1000)),
    conversationId: CONVERSATION_ID,
    ...extraParams,
  });
  params.set("signature", sign(params, secret));
  return `https://app.example.com/apps/schedule-rules/support-chat/${JOB_ID}?${params.toString()}`;
}

async function callLoader(url: string, jobId: string | undefined = JOB_ID) {
  return (await loader({
    request: new Request(url, { method: "GET" }),
    params: { jobId },
    context: {},
  } as never)) as Response;
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_SECRET", SECRET);
  getJobMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("apps.schedule-rules.support-chat.$jobId loader — signature verification", () => {
  it("rejects an invalid signature with 401 before touching the database", async () => {
    const url = signedPollUrl().replace(/signature=[0-9a-f]+/, "signature=deadbeef");
    const res = await callLoader(url);
    expect(res.status).toBe(401);
    expect((await res.json())).toEqual({ ok: false, reason: "unauthorized" });
    expect(getJobMock).not.toHaveBeenCalled();
  });
});

describe("apps.schedule-rules.support-chat.$jobId loader — ownership + anti-enumeration", () => {
  it("returns status pending while the job is still running", async () => {
    getJobMock.mockResolvedValue({ id: JOB_ID, threadId: THREAD_ID, status: "pending", blocksJson: null, error: null });
    const res = await callLoader(signedPollUrl());
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, status: "pending" });
  });

  it("returns status done with blocks once the job finishes", async () => {
    getJobMock.mockResolvedValue({
      id: JOB_ID,
      threadId: THREAD_ID,
      status: "done",
      blocksJson: JSON.stringify([{ type: "text", text: "Sige po!" }]),
      error: null,
    });
    const res = await callLoader(signedPollUrl());
    expect((await res.json())).toEqual({ ok: true, status: "done", blocks: [{ type: "text", text: "Sige po!" }] });
  });

  it("returns status failed with the error message", async () => {
    getJobMock.mockResolvedValue({ id: JOB_ID, threadId: THREAD_ID, status: "failed", blocksJson: null, error: "LLM down" });
    const res = await callLoader(signedPollUrl());
    expect((await res.json())).toEqual({ ok: true, status: "failed", error: "LLM down" });
  });

  it("never leaks another visitor's conversation — a threadId mismatch returns the SAME not_found as a missing job", async () => {
    getJobMock.mockResolvedValue({
      id: JOB_ID,
      threadId: "storefront:some-other-conversation-id",
      status: "done",
      blocksJson: JSON.stringify([{ type: "text", text: "secret" }]),
      error: null,
    });
    const mismatchRes = await callLoader(signedPollUrl());
    const mismatchJson = await mismatchRes.json();
    getJobMock.mockResolvedValue(null);
    const missingRes = await callLoader(signedPollUrl());
    const missingJson = await missingRes.json();

    expect(mismatchRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(mismatchJson).toEqual(missingJson);
    expect(mismatchJson).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when conversationId is missing from the query string", async () => {
    // Signed WITHOUT conversationId from the start, so this exercises the
    // missing-param branch specifically, not a signature failure.
    const params = new URLSearchParams({
      shop: "hsrwva-nr.myshopify.com",
      path_prefix: "/apps/schedule-rules",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    params.set("signature", sign(params, SECRET));
    const url = `https://app.example.com/apps/schedule-rules/support-chat/${JOB_ID}?${params.toString()}`;

    const res = await callLoader(url);
    expect(res.status).toBe(404);
    expect((await res.json())).toEqual({ ok: false, reason: "not_found" });
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it("returns 502 + ok:false when the lookup throws", async () => {
    getJobMock.mockRejectedValue(new Error("db down"));
    const res = await callLoader(signedPollUrl());
    expect(res.status).toBe(502);
    expect((await res.json())).toEqual({ ok: false, reason: "internal_error" });
  });
});
