import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("../app/services/messenger-send.server", () => ({
  sendMessengerTextMessage: sendMock,
}));

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
    sendMock.mockReset();
    sendMock.mockResolvedValue({ ok: true, messageId: "mid.reply" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runAction(request: Request): Promise<Response> {
    return (await action({ request, params: {}, context: {} } as never)) as Response;
  }

  it("rejects a POST with no signature header and never calls send", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "hi")), { signature: null }),
    );
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a POST signed with the wrong secret", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "hi")), { secret: "wrong" }),
    );
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects when MESSENGER_APP_SECRET is not configured", async () => {
    vi.stubEnv("MESSENGER_APP_SECRET", "");
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await runAction(new Request(ROUTE_URL, { method: "PUT", body: "{}" }));
    expect(res.status).toBe(405);
  });

  it("echoes a text message back to the sender", async () => {
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ psid: "111", text: "Echo: hi" });
  });

  it("echoes once per text message across multiple entries", async () => {
    const body = {
      object: "page",
      entry: [
        { id: "p", time: 1, messaging: [textMessageEvent("111", "one")] },
        { id: "p", time: 2, messaging: [textMessageEvent("222", "two"), textMessageEvent("333", "three")] },
      ],
    };
    const res = await runAction(makeSignedPostRequest(body));
    expect(res.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock).toHaveBeenNthCalledWith(2, { psid: "222", text: "Echo: two" });
  });

  it("never echoes an echo event (loop prevention — message_echoes is subscribed)", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "Echo: hi", { is_echo: true }))),
    );
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignores attachment-only messages (no text)", async () => {
    const event = {
      sender: { id: "111" },
      message: { mid: "mid.att", attachments: [{ type: "image" }] },
    };
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignores postback-only events", async () => {
    const event = { sender: { id: "111" }, postback: { payload: "GET_STARTED" } };
    const res = await runAction(makeSignedPostRequest(pageBody(event)));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignores standby-channel entries", async () => {
    const body = {
      object: "page",
      entry: [{ id: "p", time: 1, standby: [textMessageEvent("111", "hi")] }],
    };
    const res = await runAction(makeSignedPostRequest(body));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ignores payloads whose object is not page", async () => {
    const res = await runAction(makeSignedPostRequest({ object: "user", entry: [] }));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when the send fails", async () => {
    sendMock.mockResolvedValue({ ok: false, error: "Graph API 400: boom" });
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
  });

  it("still returns 200 when the send throws", async () => {
    sendMock.mockRejectedValue(new Error("unexpected"));
    const res = await runAction(makeSignedPostRequest(pageBody(textMessageEvent("111", "hi"))));
    expect(res.status).toBe(200);
  });

  it("returns 200 for a validly signed but malformed JSON body", async () => {
    const res = await runAction(makeSignedPostRequest("{not json"));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("truncates the echo to Messenger's 2000-char text limit", async () => {
    const res = await runAction(
      makeSignedPostRequest(pageBody(textMessageEvent("111", "x".repeat(3000)))),
    );
    expect(res.status).toBe(200);
    const sentText = sendMock.mock.calls[0][0].text as string;
    expect(sentText.startsWith("Echo: x")).toBe(true);
    expect(sentText.length).toBe(2000);
  });
});
