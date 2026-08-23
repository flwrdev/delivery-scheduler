// New anonymous-thread + channel-lookup surface added for the storefront
// chat widget (2026-08-22). Same mocking idiom as the rest of the
// support-chat suite: stub prisma, never touch a real DB.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    supportChatThread: { upsert: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  ensureAnonymousSupportChatThread,
  ensureSupportChatThread,
  getSupportChatThreadChannel,
} from "../app/services/support-chat.server";

beforeEach(() => {
  prismaMock.supportChatThread.upsert.mockReset();
  prismaMock.supportChatThread.findUnique.mockReset();
  prismaMock.supportChatThread.upsert.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ensureSupportChatThread (customer-account)", () => {
  it("creates with channel:customer-account explicitly, not relying on the column default", async () => {
    await ensureSupportChatThread({ customerGid: "gid://shopify/Customer/1001", shop: "hsrwva-nr.myshopify.com" });

    const args = prismaMock.supportChatThread.upsert.mock.calls.at(-1)?.[0];
    expect(args.where).toEqual({ id: "gid://shopify/Customer/1001" });
    expect(args.create).toEqual({
      id: "gid://shopify/Customer/1001",
      shop: "hsrwva-nr.myshopify.com",
      customerGid: "gid://shopify/Customer/1001",
      channel: "customer-account",
    });
    expect(args.update).toEqual({ shop: "hsrwva-nr.myshopify.com" });
  });
});

describe("ensureAnonymousSupportChatThread (storefront)", () => {
  const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

  it("upserts a storefront: prefixed id with a null customerGid and channel:storefront", async () => {
    const threadId = await ensureAnonymousSupportChatThread({
      conversationId: CONVERSATION_ID,
      shop: "hsrwva-nr.myshopify.com",
    });

    expect(threadId).toBe(`storefront:${CONVERSATION_ID}`);
    const args = prismaMock.supportChatThread.upsert.mock.calls.at(-1)?.[0];
    expect(args.where).toEqual({ id: `storefront:${CONVERSATION_ID}` });
    expect(args.create).toEqual({
      id: `storefront:${CONVERSATION_ID}`,
      shop: "hsrwva-nr.myshopify.com",
      customerGid: null,
      channel: "storefront",
    });
    expect(args.update).toEqual({ shop: "hsrwva-nr.myshopify.com" });
  });

  it("is idempotent across repeated turns from the same conversation", async () => {
    await ensureAnonymousSupportChatThread({ conversationId: CONVERSATION_ID, shop: "s" });
    await ensureAnonymousSupportChatThread({ conversationId: CONVERSATION_ID, shop: "s" });

    expect(prismaMock.supportChatThread.upsert).toHaveBeenCalledTimes(2);
    const [first, second] = prismaMock.supportChatThread.upsert.mock.calls.map((c) => c[0].where);
    expect(first).toEqual(second);
  });
});

describe("getSupportChatThreadChannel", () => {
  it("selects only channel and customerGid for the given thread id", async () => {
    prismaMock.supportChatThread.findUnique.mockResolvedValueOnce({
      channel: "storefront",
      customerGid: null,
    });

    const result = await getSupportChatThreadChannel("storefront:abc");

    expect(result).toEqual({ channel: "storefront", customerGid: null });
    expect(prismaMock.supportChatThread.findUnique).toHaveBeenCalledWith({
      where: { id: "storefront:abc" },
      select: { channel: true, customerGid: true },
    });
  });

  it("returns null for a thread that does not exist", async () => {
    prismaMock.supportChatThread.findUnique.mockResolvedValueOnce(null);

    const result = await getSupportChatThreadChannel("does-not-exist");

    expect(result).toBeNull();
  });
});
