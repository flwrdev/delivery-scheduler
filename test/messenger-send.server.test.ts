import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MESSENGER_GRAPH_API_VERSION,
  MESSENGER_NOT_CONFIGURED_MESSAGE,
  sendMessengerGenericTemplate,
  sendMessengerTextMessage,
} from "../app/services/messenger-send.server";

const PAGE_ID = "105284684761365";
const TOKEN = "test-page-access-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sendMessengerTextMessage", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", TOKEN);
    vi.stubEnv("MESSENGER_PAGE_ID", PAGE_ID);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a designed failure without calling fetch when the access token is missing", async () => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", "");
    const result = await sendMessengerTextMessage({ psid: "123", text: "hi" });
    expect(result).toEqual({ ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a designed failure without calling fetch when the page id is missing", async () => {
    vi.stubEnv("MESSENGER_PAGE_ID", "");
    const result = await sendMessengerTextMessage({ psid: "123", text: "hi" });
    expect(result).toEqual({ ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the Send API shape with the token in the Authorization header only", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "123", message_id: "mid.abc" }));

    const result = await sendMessengerTextMessage({ psid: "123", text: "Echo: hi" });

    expect(result).toEqual({ ok: true, messageId: "mid.abc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://graph.facebook.com/${MESSENGER_GRAPH_API_VERSION}/${PAGE_ID}/messages`,
    );
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "123" },
      messaging_type: "RESPONSE",
      message: { text: "Echo: hi" },
    });
  });

  it("includes quick_replies in the message body when provided (phase 4 slot choices)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message_id: "mid.qr" }));

    const result = await sendMessengerTextMessage({
      psid: "123",
      text: "Piliin ang oras:",
      quickReplies: [
        { title: "9AM-12PM", payload: "SLOT_9AM-12PM" },
        { title: "12PM-3PM", payload: "SLOT_12PM-3PM" },
      ],
    });

    expect(result).toEqual({ ok: true, messageId: "mid.qr" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "123" },
      messaging_type: "RESPONSE",
      message: {
        text: "Piliin ang oras:",
        quick_replies: [
          { content_type: "text", title: "9AM-12PM", payload: "SLOT_9AM-12PM" },
          { content_type: "text", title: "12PM-3PM", payload: "SLOT_12PM-3PM" },
        ],
      },
    });
  });

  it("omits quick_replies entirely when the list is empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message_id: "mid.abc" }));
    await sendMessengerTextMessage({ psid: "123", text: "hi", quickReplies: [] });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).message).toEqual({ text: "hi" });
  });

  it("trims trailing whitespace/newlines from env values", async () => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", `${TOKEN}\n`);
    vi.stubEnv("MESSENGER_PAGE_ID", `${PAGE_ID}\n`);
    fetchMock.mockResolvedValue(jsonResponse({ message_id: "mid.abc" }));

    await sendMessengerTextMessage({ psid: "123", text: "hi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://graph.facebook.com/${MESSENGER_GRAPH_API_VERSION}/${PAGE_ID}/messages`,
    );
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns ok:false with the Graph error message (never the token) on an error response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400),
    );

    const result = await sendMessengerTextMessage({ psid: "123", text: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid OAuth access token.");
      expect(result.error).not.toContain(TOKEN);
    }
  });

  it("returns ok:false without throwing when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await sendMessengerTextMessage({ psid: "123", text: "hi" });
    expect(result.ok).toBe(false);
  });

  it("returns a timeout error when the request times out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutError);

    const result = await sendMessengerTextMessage({ psid: "123", text: "hi" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain("timed out");
  });
});

describe("sendMessengerGenericTemplate (phase 5 product carousel)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", TOKEN);
    vi.stubEnv("MESSENGER_PAGE_ID", PAGE_ID);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects an empty carousel without calling fetch", async () => {
    const result = await sendMessengerGenericTemplate({ psid: "123", elements: [] });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the generic template attachment shape", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message_id: "mid.car" }), { status: 200 }),
    );

    const result = await sendMessengerGenericTemplate({
      psid: "123",
      elements: [
        {
          title: "Sweet Heart",
          subtitle: "₱799",
          imageUrl: "https://cdn.shopify.com/sh.jpg",
          buttons: [
            { type: "postback", title: "Piliin ito", payload: "PRODUCT_gid://shopify/ProductVariant/111" },
            { type: "web_url", title: "Tingnan sa website", url: "https://flowercart.store/products/sweet-heart" },
          ],
        },
      ],
    });

    expect(result).toEqual({ ok: true, messageId: "mid.car" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "123" },
      messaging_type: "RESPONSE",
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                title: "Sweet Heart",
                subtitle: "₱799",
                image_url: "https://cdn.shopify.com/sh.jpg",
                buttons: [
                  {
                    type: "postback",
                    title: "Piliin ito",
                    payload: "PRODUCT_gid://shopify/ProductVariant/111",
                  },
                  {
                    type: "web_url",
                    title: "Tingnan sa website",
                    url: "https://flowercart.store/products/sweet-heart",
                  },
                ],
              },
            ],
          },
        },
      },
    });
  });

  it("enforces the Messenger hard caps: 10 elements, 80-char title, 3 buttons", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message_id: "mid.car" }), { status: 200 }),
    );

    const longTitle = "x".repeat(120);
    const manyButtons = Array.from({ length: 5 }, (_, i) => ({
      type: "postback" as const,
      title: `B${i}`,
      payload: `P${i}`,
    }));
    const elements = Array.from({ length: 12 }, () => ({
      title: longTitle,
      buttons: manyButtons,
    }));

    await sendMessengerGenericTemplate({ psid: "123", elements });

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body).message.attachment.payload.elements;
    expect(sent).toHaveLength(10);
    expect(sent[0].title).toHaveLength(80);
    expect(sent[0].buttons).toHaveLength(3);
  });
});
