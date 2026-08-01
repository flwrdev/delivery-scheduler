import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordMock, deleteMock, processMock, enqueueMock } = vi.hoisted(() => ({
  recordMock: vi.fn(),
  deleteMock: vi.fn(),
  processMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock("../app/services/messenger-events.server", () => ({
  recordInboundTextMessage: recordMock,
  deleteRecordedMessage: deleteMock,
}));

vi.mock("../app/services/messenger-agent.server", () => ({
  processAgentTurnByMid: processMock,
}));

vi.mock("../app/services/messenger-queue.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/messenger-queue.server")>();
  return {
    ...original,
    enqueueMessengerEchoTask: enqueueMock,
  };
});

import { MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE } from "../app/services/messenger-queue.server";
import { action, loader } from "../app/routes/webhooks.messenger";

const APP_SECRET = "meta-app-secret";
const VERIFY_TOKEN = "verify-token-123";
const ROUTE_URL = "https://app.example.com/webhooks/messenger";

function makeVerifyRequest(params: Record<string, string>): Request {
  const search = new URLSearchParams(params);
  return new Request(`${ROUTE_URL}?${search.toString()}`, { method: "GET" });
}

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function makeSignedPostRequest(
  payload: unknown,
  { secret = APP_SECRET, signature }: { secret?: string; signature?: string | null } = {},
): Request {
  const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = new Headers({ "Content-Type": "application/json" });
  const resolvedSignature = signature === undefined ? signBody(rawBody, secret) : signature;
  if (resolvedSignature !== null) {
    headers.set("X-Hub-Signature-256", resolvedSignature);
  }
  return new Request(ROUTE_URL, { method: "POST", headers, body: rawBody });
}

function textMessageEvent(psid: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    sender: { id: psid },
    recipient: { id: "105284684761365" },
    timestamp: 1753600000000,
    message: { mid: `mid.${psid}.${text.length}`, text, ...overrides },
  };
}

function pageBody(...events: unknown[]) {
  return { object: "page", entry: [{ id: "105284684761365", time: 1753600000000, messaging: events }] };
}

describe("webhooks.messenger loader (GET verify handshake)", () => {
  beforeEach(() => {
    vi.stubEnv("MESSENGER_VERIFY_TOKEN", VERIFY_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("echoes hub.challenge as plain text for a valid subscribe request", async () => {
    const request = makeVerifyRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    const res = (await loader({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("1158201444");
  });

  it("rejects a wrong verify token", async () => {
    const request = makeVerifyRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong",
      "hub.challenge": "1158201444",
    });
    const res = (await loader({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects a mode other than subscribe", async () => {
    const request = makeVerifyRequest({
      "hub.mode": "unsubscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    const res = (await loader({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects a request with no challenge", async () => {
    const request = makeVerifyRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
    });
    const res = (await loader({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects when MESSENGER_VERIFY_TOKEN is not configured", async () => {
    vi.stubEnv("MESSENGER_VERIFY_TOKEN", "");
    const request = makeVerifyRequest({
      "hub.mode": "subscribe",
      "hub.verify_token": "",
      "hub.challenge": "1158201444",
    });
    const res = (await loader({ request, params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(403);
  });
});

describe("webhooks.messenger action (POST events)", () => {
  beforeEach(() => {
    vi.stubEnv("MESSENGER_APP_SECRET", APP_SECRET);
    recordMock.mockReset();
    deleteMock.mockReset();
    processMock.mockReset();
    enqueueMock.mockReset();
    recordMock.mockResolvedValue({ status: "new" });
    deleteMock.mockResolvedValue(undefined);
    processMock.mockResolvedValue({ status: "sent", replyMid: "mid.reply" });
    enqueueMock.mockResolvedValue({ ok: true, taskName: "projects/p/locations/l/queues/q/tasks/t" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runAction(request: Request): Promise<Response> {
    return (await action({ request, params: {}, context: {} } as never)) as Response;
  }

  it("rejects a POST with no signature header and never touches storage", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "hi")), { signature: null }),
    );
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("rejects a POST signed with the wrong secret", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "hi")), { secret: "wrong" }),
    );
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("rejects when MESSENGER_APP_SECRET is not configured", async () => {
    vi.stubEnv("MESSENGER_APP_SECRET", "");
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(401);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await runAction(new Request(ROUTE_URL, { method: "PUT", body: "{}" }));
    expect(res.status).toBe(405);
  });

  it("records a text message then enqueues its echo task (no inline send)", async () => {
    const event = textMessageEvent("111", "hi");
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith({
      psid: "111",
      mid: (event.message as { mid: string }).mid,
      text: "hi",
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ mid: (event.message as { mid: string }).mid });
    expect(processMock).not.toHaveBeenCalled();
  });

  it("records and enqueues once per text message across multiple entries", async () => {
    const body = {
      object: "page",
      entry: [
        { id: "p", time: 1, messaging: [textMessageEvent("111", "one")] },
        { id: "p", time: 2, messaging: [textMessageEvent("222", "two"), textMessageEvent("333", "three")] },
      ],
    };
    const res = await runAction(makeSignedPostRequest(body));
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledTimes(3);
    expect(enqueueMock).toHaveBeenCalledTimes(3);
  });

  it("skips enqueue for a duplicate mid (Meta redelivery dedupe)", async () => {
    recordMock.mockResolvedValue({ status: "duplicate" });
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
  });

  it("skips enqueue when recording fails (Meta will redeliver)", async () => {
    recordMock.mockResolvedValue({ status: "error", error: "db down" });
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("processes inline when the queue is not configured (local dev fallback)", async () => {
    enqueueMock.mockResolvedValue({
      ok: false,
      notConfigured: true,
      error: MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE,
    });
    const event = textMessageEvent("111", "hi");
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(processMock).toHaveBeenCalledWith((event.message as { mid: string }).mid);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes the recorded row on a queue infra failure so redelivery can reprocess", async () => {
    enqueueMock.mockResolvedValue({ ok: false, error: "Cloud Tasks 500" });
    const event = textMessageEvent("111", "hi");
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith((event.message as { mid: string }).mid);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("never records an echo event (loop prevention — message_echoes is subscribed)", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "Echo: hi", { is_echo: true }))),
    );
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("ignores attachment-only messages (no text)", async () => {
    const event = {
      sender: { id: "111" },
      message: { mid: "mid.att", attachments: [{ type: "image" }] },
    };
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records postback events as [TAP] messages (phase 5 — no longer ignored)", async () => {
    const event = { sender: { id: "111" }, timestamp: 5, postback: { payload: "GET_STARTED" } };
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({
      psid: "111",
      mid: "pb:111:5",
      text: "[TAP] GET_STARTED",
    });
  });

  it("ignores standby-channel entries", async () => {
    const body = {
      object: "page",
      entry: [{ id: "p", time: 1, standby: [textMessageEvent("111", "hi")] }],
    };
    const res = await runAction(makeSignedPostRequest(body));
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("ignores payloads whose object is not page", async () => {
    const res = await runAction(makeSignedPostRequest({ object: "user", entry: [] }));
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when the inline fallback send fails", async () => {
    enqueueMock.mockResolvedValue({
      ok: false,
      notConfigured: true,
      error: MESSENGER_QUEUE_NOT_CONFIGURED_MESSAGE,
    });
    processMock.mockResolvedValue({ status: "retryable_failure" });
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
  });

  it("still returns 200 when recording throws unexpectedly", async () => {
    recordMock.mockRejectedValue(new Error("unexpected"));
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
  });

  it("returns 200 for a validly signed but malformed JSON body", async () => {
    const res = await runAction(makeSignedPostRequest("{not json"));
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("webhooks.messenger action — postback events (phase 5 carousel taps)", () => {
  beforeEach(() => {
    vi.stubEnv("MESSENGER_APP_SECRET", APP_SECRET);
    recordMock.mockResolvedValue({ status: "new" });
    enqueueMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("records a product postback as a [TAP] message with a synthetic mid and enqueues it", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      recipient: { id: "105284684761365" },
      timestamp: 1753600001234,
      postback: {
        title: "Piliin ito",
        payload: "PRODUCT_gid://shopify/ProductVariant/111",
      },
    });
    const res = (await action({
      request: makeSignedPostRequest(body),
      params: {},
      context: {},
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({
      psid: "24680",
      mid: "pb:24680:1753600001234",
      text: "[TAP] PRODUCT_gid://shopify/ProductVariant/111",
    });
    expect(enqueueMock).toHaveBeenCalledWith({ mid: "pb:24680:1753600001234" });
  });

  it("prefers the postback's own mid when Meta provides one", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600001234,
      postback: { mid: "m.postback.1", payload: "PRODUCT_gid://shopify/ProductVariant/2" },
    });
    await action({ request: makeSignedPostRequest(body), params: {}, context: {} } as never);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ mid: "m.postback.1" }),
    );
  });

  it("ignores a postback without a payload", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600001234,
      postback: { title: "Get Started" },
    });
    const res = (await action({
      request: makeSignedPostRequest(body),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("still handles a plain text event exactly as before (no regression)", async () => {
    const body = pageBody(textMessageEvent("13579", "hello"));
    await action({ request: makeSignedPostRequest(body), params: {}, context: {} } as never);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ psid: "13579", text: "hello" }),
    );
  });
});

describe("webhooks.messenger action — quick-reply taps (phase 6 Confirm path)", () => {
  beforeEach(() => {
    vi.stubEnv("MESSENGER_APP_SECRET", APP_SECRET);
    recordMock.mockResolvedValue({ status: "new" });
    enqueueMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("records the quick_reply PAYLOAD as [TAP] text — never the button title", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600002000,
      message: {
        mid: "m.qr.confirm.1",
        text: "Confirm ✅", // the visible title — must NOT be recorded
        quick_reply: { payload: "CONFIRM_ORDER_3f1c9d2e-1111-2222-3333-444455556666" },
      },
    });
    const res = (await action({
      request: makeSignedPostRequest(body),
      params: {},
      context: {},
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({
      psid: "24680",
      mid: "m.qr.confirm.1",
      text: "[TAP] CONFIRM_ORDER_3f1c9d2e-1111-2222-3333-444455556666",
    });
    expect(enqueueMock).toHaveBeenCalledWith({ mid: "m.qr.confirm.1" });
  });

  it("records a slot quick reply the same way (existing SLOT_ payloads keep working)", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600002001,
      message: { mid: "m.qr.slot.1", text: "9AM-12PM", quick_reply: { payload: "SLOT_9AM-12PM" } },
    });
    await action({ request: makeSignedPostRequest(body), params: {}, context: {} } as never);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ mid: "m.qr.slot.1", text: "[TAP] SLOT_9AM-12PM" }),
    );
  });

  it("falls back to plain text when quick_reply has no string payload", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600002002,
      message: { mid: "m.qr.bad.1", text: "hello", quick_reply: {} },
    });
    await action({ request: makeSignedPostRequest(body), params: {}, context: {} } as never);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
  });

  it("never records a quick reply on an echo event", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600002003,
      message: {
        mid: "m.qr.echo.1",
        text: "Confirm ✅",
        is_echo: true,
        quick_reply: { payload: "CONFIRM_ORDER_x" },
      },
    });
    const res = (await action({
      request: makeSignedPostRequest(body),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("skips a quick reply without a mid (cannot dedupe it)", async () => {
    const body = pageBody({
      sender: { id: "24680" },
      timestamp: 1753600002004,
      message: { text: "Confirm ✅", quick_reply: { payload: "CONFIRM_ORDER_x" } },
    });
    const res = (await action({
      request: makeSignedPostRequest(body),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(recordMock).not.toHaveBeenCalled();
  });
});
