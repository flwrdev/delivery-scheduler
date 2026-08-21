// Tests for the transport-free agent brain (app/services/agent-core.server.ts).
//
// The brain is mocked at exactly two seams — runLlmTurn and executeAgentTool —
// same as test/messenger-agent.server.test.ts. Everything below the seams
// (Prisma, the Meta Send API, Cloud Tasks) is stubbed out entirely: agent-core
// must never touch any of it, and a failure here that mentions those modules
// means the brain grew a transport dependency it should not have.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  llmMock,
  executeToolMock,
  sendMock,
  carouselMock,
  senderActionMock,
  confirmMock,
  summaryMock,
  claimFollowUpMock,
  enqueueFollowUpMock,
} = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { findUnique: vi.fn(), update: vi.fn() },
    messengerMessage: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  llmMock: vi.fn(),
  executeToolMock: vi.fn(),
  sendMock: vi.fn(),
  carouselMock: vi.fn(),
  senderActionMock: vi.fn(),
  confirmMock: vi.fn(),
  summaryMock: vi.fn(),
  claimFollowUpMock: vi.fn(),
  enqueueFollowUpMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/services/messenger-llm.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/messenger-llm.server")>();
  return { ...original, runLlmTurn: llmMock };
});
// Fully mocked (no importOriginal): the real module imports shopify.server,
// whose Prisma session storage cannot initialize inside vitest.
vi.mock("../app/services/messenger-agent-tools.server", () => ({
  executeAgentTool: executeToolMock,
  getManilaNowLabel: () => "Saturday, August 1, 2026 at 12:00 PM",
  MESSENGER_AGENT_TOOLS: [
    { name: "resolve_date", description: "", input_schema: { type: "object", properties: {} } },
    { name: "update_order", description: "", input_schema: { type: "object", properties: {} } },
  ],
}));
// Fully mocked (no importOriginal): the real module imports shopify.server
// and db.server.
vi.mock("../app/services/messenger-orders.server", () => ({
  confirmMessengerOrder: confirmMock,
  buildOrderSummaryText: summaryMock,
  claimOrderFollowUp: claimFollowUpMock,
}));
vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueMessengerFollowUpTask: enqueueFollowUpMock,
}));
vi.mock("../app/services/cod-facts.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/cod-facts.server")>();
  return { ...original, loadCodFacts: async () => original.COD_FACTS_FALLBACK };
});
vi.mock("../app/services/messenger-send.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/messenger-send.server")>();
  return {
    ...original,
    sendMessengerTextMessage: sendMock,
    sendMessengerGenericTemplate: carouselMock,
    sendMessengerSenderAction: senderActionMock,
  };
});

import { MESSENGER_LLM_NOT_CONFIGURED_MESSAGE } from "../app/services/messenger-llm.server";
import type { LlmMessage } from "../app/services/messenger-llm.server";
import {
  CUSTOMER_ACCOUNT_CAPABILITIES,
  MESSENGER_CAPABILITIES,
  STOREFRONT_CAPABILITIES,
} from "../app/services/agent-channel";
import type { AgentBlock, AgentChannel, ChannelCapabilities } from "../app/services/agent-channel";
import { AGENT_NO_FINAL_TEXT_ERROR, runAgentTurn } from "../app/services/agent-core.server";

const PSID = "24681357900001";
const NOW = new Date("2026-08-01T04:00:00Z");

function messengerChannel(supports: ChannelCapabilities = MESSENGER_CAPABILITIES): AgentChannel {
  return {
    kind: "messenger",
    identity: { type: "psid", psid: PSID },
    supports,
    threadId: PSID,
  };
}

function webChannel(supports: ChannelCapabilities = CUSTOMER_ACCOUNT_CAPABILITIES): AgentChannel {
  return {
    kind: "customer-account",
    identity: { type: "customer", customerGid: "gid://shopify/Customer/1" },
    supports,
    threadId: "gid://shopify/Customer/1",
  };
}

function storefrontChannel(): AgentChannel {
  return {
    kind: "storefront",
    identity: { type: "anonymous", conversationId: "conv-1" },
    supports: STOREFRONT_CAPABILITIES,
    threadId: "conv-1",
  };
}

function history(text = "pwede ba bukas?"): LlmMessage[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

function textTurn(text: string) {
  return { ok: true as const, stopReason: "end_turn", blocks: [{ type: "text" as const, text }] };
}

function toolTurn(name: string, input: unknown = {}, id = "tu_1") {
  return {
    ok: true as const,
    stopReason: "tool_use",
    blocks: [{ type: "tool_use" as const, id, name, input }],
  };
}

function blockOfType<T extends AgentBlock["type"]>(
  blocks: AgentBlock[],
  type: T,
): Extract<AgentBlock, { type: T }> | undefined {
  return blocks.find((block) => block.type === type) as
    | Extract<AgentBlock, { type: T }>
    | undefined;
}

const OPEN_SLOTS_RESULT = {
  ok: true,
  date: "2026-08-02",
  weekday: "Sunday",
  available: true,
  slots: [
    { value: "9AM-12PM", label: "9AM - 12PM" },
    { value: "1PM-5PM", label: "1PM - 5PM" },
  ],
};

const PRODUCTS_RESULT = {
  ok: true,
  products: [
    {
      productTitle: "Sweet Heart",
      variantId: "gid://shopify/ProductVariant/1",
      pricePhp: 1500,
      available: true,
    },
  ],
  note: "",
};

const READY_ORDER_RESULT = {
  ok: true,
  state: { status: "awaiting_confirm" },
  missing: [],
  readyToConfirm: true,
  orderKey: "b3f1c0de",
  errors: [],
  note: "",
};

let ordersEnabledBefore: string | undefined;

beforeEach(() => {
  ordersEnabledBefore = process.env.MESSENGER_ORDERS_ENABLED;
  llmMock.mockResolvedValue(textTurn("Sige po!"));
  executeToolMock.mockResolvedValue({ ok: true });
  summaryMock.mockReturnValue("🧾 ORDER SUMMARY (deterministic)");
});

afterEach(() => {
  if (ordersEnabledBefore === undefined) {
    delete process.env.MESSENGER_ORDERS_ENABLED;
  } else {
    process.env.MESSENGER_ORDERS_ENABLED = ordersEnabledBefore;
  }
  vi.clearAllMocks();
});

describe("runAgentTurn — text-only turn", () => {
  it("returns a single text block and no tools used", async () => {
    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolsUsed).toEqual([]);
    expect(result.reply.blocks).toEqual([{ type: "text", text: "Sige po!" }]);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("passes the static and volatile system halves SEPARATELY (prompt cache split)", async () => {
    await runAgentTurn({ channel: messengerChannel(), messages: history(), now: NOW });

    const args = llmMock.mock.calls[0][0];
    expect(typeof args.system).toBe("string");
    expect(args.system).toContain("You are FlowerBot");
    expect(args.system).not.toContain("Current date and time in Asia/Manila");
    expect(args.systemContext).toContain("Current date and time in Asia/Manila");
  });

  it("never mutates the caller's message array", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("resolve_date", { base: "tomorrow" }));
    llmMock.mockResolvedValueOnce(textTurn("Bukas po, Linggo."));
    const messages = history();

    await runAgentTurn({ channel: messengerChannel(), messages, now: NOW });

    expect(messages).toHaveLength(1);
  });

  it("drops update_order from the tool list when ordering is off, keeps it when on", async () => {
    delete process.env.MESSENGER_ORDERS_ENABLED;
    await runAgentTurn({ channel: messengerChannel(), messages: history(), now: NOW });
    expect(llmMock.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "resolve_date",
    ]);

    llmMock.mockClear();
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    await runAgentTurn({ channel: messengerChannel(), messages: history(), now: NOW });
    expect(llmMock.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toEqual([
      "resolve_date",
      "update_order",
    ]);
  });
});

describe("runAgentTurn — tool loop", () => {
  it("executes one tool call, feeds the result back, and finishes on the text turn", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("resolve_date", { base: "tomorrow" }, "tu_a"));
    llmMock.mockResolvedValueOnce(textTurn("Bukas po, Linggo Aug 2."));
    executeToolMock.mockResolvedValueOnce({ ok: true, isoDate: "2026-08-02" });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolsUsed).toEqual(["resolve_date"]);
    expect(result.reply.blocks).toEqual([{ type: "text", text: "Bukas po, Linggo Aug 2." }]);

    // Tools get the CHANNEL-AGNOSTIC key, not a psid field.
    expect(executeToolMock).toHaveBeenCalledWith(
      "resolve_date",
      { base: "tomorrow" },
      NOW,
      { threadId: PSID },
    );

    // The 2nd LLM call carries the assistant tool_use turn + one user message
    // holding ALL tool_results.
    const secondCallMessages = llmMock.mock.calls[1][0].messages as LlmMessage[];
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages[1].role).toBe("assistant");
    expect(secondCallMessages[2].role).toBe("user");
    expect(secondCallMessages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_a",
    });
  });

  it("returns all tool results of one turn in a SINGLE user message", async () => {
    llmMock.mockResolvedValueOnce({
      ok: true,
      stopReason: "tool_use",
      blocks: [
        { type: "tool_use", id: "tu_a", name: "resolve_date", input: {} },
        { type: "tool_use", id: "tu_b", name: "check_delivery_coverage", input: {} },
      ],
    });
    llmMock.mockResolvedValueOnce(textTurn("Ayan po."));

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolsUsed).toEqual(["resolve_date", "check_delivery_coverage"]);
    const secondCallMessages = llmMock.mock.calls[1][0].messages as LlmMessage[];
    expect(secondCallMessages[2].content).toHaveLength(2);
  });

  it("stops at the 5-iteration ceiling with a designed error", async () => {
    llmMock.mockResolvedValue(toolTurn("resolve_date"));

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result).toEqual({ ok: false, error: AGENT_NO_FINAL_TEXT_ERROR });
    expect(llmMock).toHaveBeenCalledTimes(5);
    expect(executeToolMock).toHaveBeenCalledTimes(5);
  });
});

describe("runAgentTurn — failure shapes", () => {
  it("passes notConfigured through instead of throwing", async () => {
    llmMock.mockResolvedValue({
      ok: false,
      error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
      notConfigured: true,
    });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result).toEqual({
      ok: false,
      error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
      notConfigured: true,
    });
  });

  it("flags notConfigured from the message alone when the flag is missing", async () => {
    llmMock.mockResolvedValue({ ok: false, error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, notConfigured: true });
  });

  it("returns a plain error (not notConfigured) for a transient LLM failure", async () => {
    llmMock.mockResolvedValue({ ok: false, error: "upstream 529" });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result).toEqual({ ok: false, error: "upstream 529" });
  });

  it("returns a designed error when the model answers with whitespace only", async () => {
    llmMock.mockResolvedValue(textTurn("   \n  "));

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result).toEqual({ ok: false, error: AGENT_NO_FINAL_TEXT_ERROR });
  });
});

describe("runAgentTurn — channel capabilities", () => {
  it("sanitizes markdown when the channel cannot render it", async () => {
    llmMock.mockResolvedValue(textTurn("Ang **Sweet Heart** po ay P1,500 — libre ang delivery."));

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = blockOfType(result.reply.blocks, "text")?.text ?? "";
    expect(text).toContain("Sweet Heart");
    expect(text).not.toContain("**");
    expect(text).not.toContain("—");
  });

  it("PRESERVES markdown when the channel renders it", async () => {
    llmMock.mockResolvedValue(textTurn("Ang **Sweet Heart** po ay P1,500 — libre ang delivery."));

    const result = await runAgentTurn({
      channel: webChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = blockOfType(result.reply.blocks, "text")?.text ?? "";
    expect(text).toBe("Ang **Sweet Heart** po ay P1,500 — libre ang delivery.");
  });

  it("slices the text to the channel's textLimit", async () => {
    llmMock.mockResolvedValue(textTurn("A".repeat(4000)));

    const result = await runAgentTurn({
      channel: messengerChannel({ ...MESSENGER_CAPABILITIES, textLimit: 25 }),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "text")?.text).toBe("A".repeat(25));
  });
});

describe("runAgentTurn — affordance blocks", () => {
  it("emits a slots block for an OPEN get_available_slots result", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("get_available_slots", { date: "2026-08-02" }));
    llmMock.mockResolvedValueOnce(textTurn("Heto po ang bakante."));
    executeToolMock.mockResolvedValueOnce(OPEN_SLOTS_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reply.blocks[0].type).toBe("text");
    expect(blockOfType(result.reply.blocks, "slots")).toEqual({
      type: "slots",
      date: "2026-08-02",
      slots: [
        { value: "9AM-12PM", label: "9AM - 12PM" },
        { value: "1PM-5PM", label: "1PM - 5PM" },
      ],
    });
  });

  it("emits no slots block when the date is closed or full", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("get_available_slots", { date: "2026-08-02" }));
    llmMock.mockResolvedValueOnce(textTurn("Puno na po."));
    executeToolMock.mockResolvedValueOnce({
      ok: true,
      date: "2026-08-02",
      weekday: "Sunday",
      available: false,
      reason: "full",
      nearestAvailableDates: [],
    });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "slots")).toBeUndefined();
  });

  it("emits a products block for a browse search_products result", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("search_products", { query: "rose" }));
    llmMock.mockResolvedValueOnce(textTurn("Heto po ang options 🌸"));
    executeToolMock.mockResolvedValueOnce(PRODUCTS_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reply.blocks[0].type).toBe("text");
    expect(blockOfType(result.reply.blocks, "products")).toEqual({
      type: "products",
      items: PRODUCTS_RESULT.products,
    });
  });

  it("emits a products block for get_best_sellers", async () => {
    llmMock.mockResolvedValueOnce(toolTurn("get_best_sellers"));
    llmMock.mockResolvedValueOnce(textTurn("Ito po ang paborito."));
    executeToolMock.mockResolvedValueOnce(PRODUCTS_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "products")?.items).toEqual(PRODUCTS_RESULT.products);
  });

  it("emits NO products block for a lookup-purpose search (the customer is picking)", async () => {
    llmMock.mockResolvedValueOnce(
      toolTurn("search_products", { query: "Sweet Heart", purpose: "lookup" }),
    );
    llmMock.mockResolvedValueOnce(textTurn("Ang Sweet Heart po ay P1,500."));
    executeToolMock.mockResolvedValueOnce(PRODUCTS_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "products")).toBeUndefined();
    expect(result.reply.blocks).toHaveLength(1);
  });

  it("emits a summary block carrying the deterministic text and the orderKey", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce(toolTurn("update_order", { time_slot: "9AM-12PM" }));
    llmMock.mockResolvedValueOnce(textTurn("Paki-check po ang summary sa baba 👇"));
    executeToolMock.mockResolvedValueOnce(READY_ORDER_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summaryMock).toHaveBeenCalledWith(READY_ORDER_RESULT.state);
    expect(blockOfType(result.reply.blocks, "summary")).toEqual({
      type: "summary",
      text: "🧾 ORDER SUMMARY (deterministic)",
      orderKey: "b3f1c0de",
    });
  });

  it("SUPPRESSES products when a summary block is present (the confirm affordance wins)", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce({
      ok: true,
      stopReason: "tool_use",
      blocks: [
        { type: "tool_use", id: "tu_a", name: "search_products", input: { query: "rose" } },
        { type: "tool_use", id: "tu_b", name: "update_order", input: { time_slot: "9AM-12PM" } },
      ],
    });
    llmMock.mockResolvedValueOnce(textTurn("Paki-check po ang summary sa baba 👇"));
    executeToolMock
      .mockResolvedValueOnce(PRODUCTS_RESULT)
      .mockResolvedValueOnce(READY_ORDER_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "products")).toBeUndefined();
    expect(blockOfType(result.reply.blocks, "summary")).toBeDefined();
  });

  it("emits the four add-on choices when the next missing field is add_on", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce(toolTurn("update_order", { time_slot: "9AM-12PM" }));
    llmMock.mockResolvedValueOnce(textTurn("Gusto niyo po bang samahan ng add-on?"));
    executeToolMock.mockResolvedValueOnce({
      ...READY_ORDER_RESULT,
      readyToConfirm: false,
      missing: ["add_on"],
      orderKey: undefined,
    });

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "choices")?.options).toEqual([
      { label: "🧸 Bear", payload: "ADDON_BEAR" },
      { label: "🍫 Chocolates", payload: "ADDON_CHOCOLATES" },
      { label: "🎈 Balloon", payload: "ADDON_BALLOON" },
      { label: "Hindi na po", payload: "ADDON_NONE" },
    ]);
  });

  it("SUPPRESSES slots and choices when products are present", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce({
      ok: true,
      stopReason: "tool_use",
      blocks: [
        { type: "tool_use", id: "tu_a", name: "get_available_slots", input: { date: "2026-08-02" } },
        { type: "tool_use", id: "tu_b", name: "search_products", input: { query: "rose" } },
      ],
    });
    llmMock.mockResolvedValueOnce(textTurn("Heto po."));
    executeToolMock.mockResolvedValueOnce(OPEN_SLOTS_RESULT).mockResolvedValueOnce(PRODUCTS_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "products")).toBeDefined();
    expect(blockOfType(result.reply.blocks, "slots")).toBeUndefined();
    expect(blockOfType(result.reply.blocks, "choices")).toBeUndefined();
  });

  it("never touches Prisma or the Meta Send API", async () => {
    await runAgentTurn({ channel: messengerChannel(), messages: history(), now: NOW });

    expect(sendMock).not.toHaveBeenCalled();
    expect(carouselMock).not.toHaveBeenCalled();
    expect(senderActionMock).not.toHaveBeenCalled();
    expect(prismaMock.messengerMessage.create).not.toHaveBeenCalled();
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
    expect(enqueueFollowUpMock).not.toHaveBeenCalled();
  });
});

// The web channels are READ-ONLY SUPPORT in v1 (merchant decision): ordering
// stays Messenger-only. Two things enforce that here — the tool list and the
// summary block — and BOTH must hold even with MESSENGER_ORDERS_ENABLED=true,
// because order state is keyed by MessengerThread.psid and the deterministic
// CONFIRM_ORDER_ interception only exists in the Messenger adapter.
describe("runAgentTurn — per-channel ordering gate", () => {
  function toolNames(callIndex = 0): string[] {
    return llmMock.mock.calls[callIndex][0].tools.map((tool: { name: string }) => tool.name);
  }

  it("omits update_order for customer-account even when MESSENGER_ORDERS_ENABLED is true", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";

    await runAgentTurn({ channel: webChannel(), messages: history(), now: NOW });

    expect(toolNames()).toEqual(["resolve_date"]);
    expect(toolNames()).not.toContain("update_order");
  });

  it("omits update_order for the storefront even when MESSENGER_ORDERS_ENABLED is true", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";

    await runAgentTurn({ channel: storefrontChannel(), messages: history(), now: NOW });

    expect(toolNames()).toEqual(["resolve_date"]);
    expect(toolNames()).not.toContain("update_order");
  });

  it("KEEPS update_order for messenger (the one channel that can carry order state)", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";

    await runAgentTurn({ channel: messengerChannel(), messages: history(), now: NOW });

    expect(toolNames()).toContain("update_order");
  });

  it("tells a non-ordering channel's prompt that it cannot take orders", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";

    await runAgentTurn({ channel: webChannel(), messages: history(), now: NOW });

    expect(llmMock.mock.calls[0][0].system).toContain("You cannot take orders or payments yet");
    expect(llmMock.mock.calls[0][0].system).not.toContain("ORDERING (you CAN take orders");
  });

  it("DROPS a summary block on a non-ordering channel (a confirm affordance with no confirm path)", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    // The tool list already excludes update_order here — this drives the tool
    // anyway so the defensive drop itself is what is under test.
    llmMock.mockResolvedValueOnce(toolTurn("update_order", { time_slot: "9AM-12PM" }));
    llmMock.mockResolvedValueOnce(textTurn("Paki-check po ang summary sa baba 👇"));
    executeToolMock.mockResolvedValueOnce(READY_ORDER_RESULT);

    const result = await runAgentTurn({ channel: webChannel(), messages: history(), now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "summary")).toBeUndefined();
    expect(result.reply.blocks.every((block) => block.type !== "summary")).toBe(true);
  });

  it("KEEPS the summary block on messenger", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce(toolTurn("update_order", { time_slot: "9AM-12PM" }));
    llmMock.mockResolvedValueOnce(textTurn("Paki-check po ang summary sa baba 👇"));
    executeToolMock.mockResolvedValueOnce(READY_ORDER_RESULT);

    const result = await runAgentTurn({
      channel: messengerChannel(),
      messages: history(),
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "summary")).toEqual({
      type: "summary",
      text: "🧾 ORDER SUMMARY (deterministic)",
      orderKey: "b3f1c0de",
    });
  });

  it("restores the product cards a dropped summary would have suppressed", async () => {
    process.env.MESSENGER_ORDERS_ENABLED = "true";
    llmMock.mockResolvedValueOnce({
      ok: true,
      stopReason: "tool_use",
      blocks: [
        { type: "tool_use", id: "tu_a", name: "search_products", input: { query: "rose" } },
        { type: "tool_use", id: "tu_b", name: "update_order", input: { time_slot: "9AM-12PM" } },
      ],
    });
    llmMock.mockResolvedValueOnce(textTurn("Heto po ang options 🌸"));
    executeToolMock
      .mockResolvedValueOnce(PRODUCTS_RESULT)
      .mockResolvedValueOnce(READY_ORDER_RESULT);

    const result = await runAgentTurn({ channel: webChannel(), messages: history(), now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blockOfType(result.reply.blocks, "summary")).toBeUndefined();
    expect(blockOfType(result.reply.blocks, "products")?.items).toEqual(PRODUCTS_RESULT.products);
  });
});
