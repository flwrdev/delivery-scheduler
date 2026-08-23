// Dedicated coverage for runSupportChatTurn's channel-reconstruction branch
// (storefront widget, 2026-08-22) — the guard tests already live indirectly
// via test/api-support-chat-route.test.ts and
// test/webhooks-support-chat-worker.test.ts; this file focuses on the NEW
// logic: reading channel off the thread row and building the right
// AgentChannel, rather than re-deriving guard coverage those files already
// own. Same mocking idiom throughout: every service seam mocked, no real
// DB/LLM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getThreadChannelMock,
  loadHistoryMock,
  completeJobMock,
  skipJobMock,
  runAgentTurnMock,
  CUSTOMER_ACCOUNT_CAPABILITIES,
  STOREFRONT_CAPABILITIES,
} = vi.hoisted(() => ({
  getThreadChannelMock: vi.fn(),
  loadHistoryMock: vi.fn(),
  completeJobMock: vi.fn(),
  skipJobMock: vi.fn(),
  runAgentTurnMock: vi.fn(),
  CUSTOMER_ACCOUNT_CAPABILITIES: Object.freeze({
    markdown: true,
    carousel: false,
    quickReplies: true,
    productCards: true,
    textLimit: 4000,
    ordering: false,
  }),
  STOREFRONT_CAPABILITIES: Object.freeze({
    markdown: true,
    carousel: false,
    quickReplies: true,
    productCards: true,
    textLimit: 4000,
    ordering: false,
  }),
}));

vi.mock("../app/services/support-chat.server", () => ({
  getSupportChatThreadChannel: getThreadChannelMock,
  loadSupportChatHistory: loadHistoryMock,
  completeSupportChatJob: completeJobMock,
  skipSupportChatJob: skipJobMock,
}));

vi.mock("../app/services/agent-core.server", () => ({
  runAgentTurn: runAgentTurnMock,
  CUSTOMER_ACCOUNT_CAPABILITIES,
  STOREFRONT_CAPABILITIES,
}));

import { runSupportChatTurn } from "../app/services/support-chat-turn.server";

const JOB_ID = "job-1";

function customerTurn(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(() => {
  getThreadChannelMock.mockReset();
  loadHistoryMock.mockReset();
  completeJobMock.mockReset();
  skipJobMock.mockReset();
  runAgentTurnMock.mockReset();

  loadHistoryMock.mockResolvedValue([customerTurn("magkano po delivery sa Makati?")]);
  completeJobMock.mockResolvedValue(undefined);
  skipJobMock.mockResolvedValue(undefined);
  runAgentTurnMock.mockResolvedValue({
    ok: true,
    reply: { blocks: [{ type: "text", text: "Around P250 po." }] },
    toolsUsed: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runSupportChatTurn — channel reconstruction", () => {
  it("builds a customer identity + CUSTOMER_ACCOUNT_CAPABILITIES for a customer-account thread", async () => {
    const threadId = "gid://shopify/Customer/1001";
    getThreadChannelMock.mockResolvedValue({ channel: "customer-account", customerGid: threadId });

    const verdict = await runSupportChatTurn({ jobId: JOB_ID, threadId });

    expect(verdict).toEqual({ status: "done", intercepted: false });
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    const { channel } = runAgentTurnMock.mock.calls[0][0];
    expect(channel).toEqual({
      kind: "customer-account",
      identity: { type: "customer", customerGid: threadId },
      supports: CUSTOMER_ACCOUNT_CAPABILITIES,
      threadId,
    });
  });

  it("builds an anonymous identity + STOREFRONT_CAPABILITIES for a storefront thread, stripping the storefront: prefix from conversationId", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const threadId = `storefront:${conversationId}`;
    getThreadChannelMock.mockResolvedValue({ channel: "storefront", customerGid: null });

    const verdict = await runSupportChatTurn({ jobId: JOB_ID, threadId });

    expect(verdict).toEqual({ status: "done", intercepted: false });
    const { channel } = runAgentTurnMock.mock.calls[0][0];
    expect(channel).toEqual({
      kind: "storefront",
      identity: { type: "anonymous", conversationId },
      supports: STOREFRONT_CAPABILITIES,
      threadId,
    });
  });

  it("never exposes ordering on the storefront channel (STOREFRONT_CAPABILITIES.ordering stays false)", async () => {
    getThreadChannelMock.mockResolvedValue({ channel: "storefront", customerGid: null });

    await runSupportChatTurn({ jobId: JOB_ID, threadId: "storefront:abc" });

    const { channel } = runAgentTurnMock.mock.calls[0][0];
    expect(channel.supports.ordering).toBe(false);
  });

  it("returns a failed verdict without calling runAgentTurn when the thread is missing (should be unreachable, defensive)", async () => {
    getThreadChannelMock.mockResolvedValue(null);

    const verdict = await runSupportChatTurn({ jobId: JOB_ID, threadId: "does-not-exist" });

    expect(verdict).toEqual({ status: "failed", error: "thread not found", notConfigured: false });
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(completeJobMock).not.toHaveBeenCalled();
  });

  it("still applies the empty-history skip guard before ever reading the thread's channel", async () => {
    loadHistoryMock.mockResolvedValue([]);

    const verdict = await runSupportChatTurn({ jobId: JOB_ID, threadId: "storefront:abc" });

    expect(verdict).toEqual({ status: "skipped", reason: "empty_history" });
    expect(getThreadChannelMock).not.toHaveBeenCalled();
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("still intercepts an order-commitment payload before ever reading the thread's channel", async () => {
    loadHistoryMock.mockResolvedValue([customerTurn("CONFIRM_ORDER_b3f1c0de")]);

    const verdict = await runSupportChatTurn({ jobId: JOB_ID, threadId: "storefront:abc" });

    expect(verdict).toEqual({ status: "done", intercepted: true });
    expect(getThreadChannelMock).not.toHaveBeenCalled();
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it("falls back to threadId as the customerGid when the thread row's customerGid is null (defensive, should not happen for a real customer-account row)", async () => {
    const threadId = "gid://shopify/Customer/2002";
    getThreadChannelMock.mockResolvedValue({ channel: "customer-account", customerGid: null });

    await runSupportChatTurn({ jobId: JOB_ID, threadId });

    const { channel } = runAgentTurnMock.mock.calls[0][0];
    expect(channel.identity).toEqual({ type: "customer", customerGid: threadId });
  });
});
