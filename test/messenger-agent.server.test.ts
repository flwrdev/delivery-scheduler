import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, llmMock, executeToolMock, sendMock, carouselMock } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { findUnique: vi.fn(), update: vi.fn() },
    messengerMessage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  llmMock: vi.fn(),
  executeToolMock: vi.fn(),
  sendMock: vi.fn(),
  carouselMock: vi.fn(),
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
  MESSENGER_AGENT_TOOLS: [],
}));
vi.mock("../app/services/messenger-send.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/messenger-send.server")>();
  return {
    ...original,
    sendMessengerTextMessage: sendMock,
    sendMessengerGenericTemplate: carouselMock,
  };
});

import { MESSENGER_LLM_NOT_CONFIGURED_MESSAGE } from "../app/services/messenger-llm.server";
import { processAgentTurnByMid } from "../app/services/messenger-agent.server";

const PSID = "24681357900001";
const MID = "mid.customer.1";

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmid1",
    psid: PSID,
    role: "customer",
    bodyJson: JSON.stringify({ text: "pwede ba bukas?" }),
    mid: MID,
    repliedAt: null,
    replyMid: null,
    createdAt: new Date("2026-08-01T04:00:00Z"),
    ...overrides,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    psid: PSID,
    humanControl: false,
    humanControlAt: null,
    lastCustomerAt: new Date(),
    disclosedBot: true,
    state: "idle",
    shopifyCustomerId: null,
    ...overrides,
  };
}

function textTurn(text: string) {
  return { ok: true as const, stopReason: "end_turn", blocks: [{ type: "text" as const, text }] };
}

beforeEach(() => {
  prismaMock.messengerMessage.findUnique.mockResolvedValue(customerRow());
  prismaMock.messengerMessage.findMany.mockResolvedValue([customerRow()]);
  prismaMock.messengerMessage.create.mockResolvedValue({});
  prismaMock.messengerMessage.update.mockResolvedValue({});
  prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow());
  prismaMock.messengerThread.update.mockResolvedValue({});
  llmMock.mockResolvedValue(textTurn("Sige po!"));
  sendMock.mockResolvedValue({ ok: true, messageId: "mid.bot.new" });
  carouselMock.mockResolvedValue({ ok: true, messageId: "mid.bot.carousel" });
  executeToolMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("processAgentTurnByMid", () => {
  it("returns not_found for an unknown mid", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(null);
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("not_found");
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("skips already-replied messages without calling the LLM (retry idempotency)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerRow({ repliedAt: new Date() }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(llmMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends the LLM's text reply and does the reply bookkeeping", async () => {
    const result = await processAgentTurnByMid(MID);
    expect(result).toMatchObject({ status: "sent", replyMid: "mid.bot.new" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.psid).toBe(PSID);
    expect(sendArgs.text).toContain("Sige po!");

    const updateArgs = prismaMock.messengerMessage.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ mid: MID });
    expect(updateArgs.data.replyMid).toBe("mid.bot.new");
    expect(updateArgs.data.repliedAt).toBeInstanceOf(Date);

    const botCreate = prismaMock.messengerMessage.create.mock.calls.find(
      ([args]) => args.data.role === "bot",
    );
    expect(botCreate?.[0].data.mid).toBe("mid.bot.new");
  });

  it("includes the current Manila datetime in the system prompt on every turn", async () => {
    await processAgentTurnByMid(MID);
    const { system } = llmMock.mock.calls[0][0];
    expect(system).toContain("Asia/Manila");
    // The truthfulness rule goes in verbatim (master doc hard rule).
    expect(system).toContain("Never state a price, availability, or delivery date");
  });

  it("feeds prior thread history to the LLM in chronological order (query is newest-first)", async () => {
    // The service queries newest-first and reverses — mock rows arrive DESC.
    prismaMock.messengerMessage.findMany.mockResolvedValue([
      customerRow(),
      customerRow({
        mid: "m2",
        role: "bot",
        bodyJson: JSON.stringify({ text: "Kumusta po!" }),
        createdAt: new Date(2),
      }),
      customerRow({ mid: "m1", bodyJson: JSON.stringify({ text: "hello" }), createdAt: new Date(1) }),
    ]);
    await processAgentTurnByMid(MID);
    const { messages } = llmMock.mock.calls[0][0];
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
  });

  it("runs the tool loop: executes tool calls and continues until a text turn", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "toolu_1", name: "resolve_date", input: { base: "tomorrow" } },
        ],
      })
      .mockResolvedValueOnce(textTurn("Linggo, Aug 2 po iyon. Anong oras?"));
    executeToolMock.mockResolvedValue({ ok: true, isoDate: "2026-08-02", weekday: "Sunday" });

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
    expect(executeToolMock).toHaveBeenCalledWith(
      "resolve_date",
      { base: "tomorrow" },
      expect.any(Date),
    );
    expect(llmMock).toHaveBeenCalledTimes(2);

    // The second call must carry the assistant tool_use turn + the tool_result.
    const secondMessages = llmMock.mock.calls[1][0].messages;
    const last = secondMessages[secondMessages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
    expect(last.content[0].tool_use_id).toBe("toolu_1");
  });

  it("attaches slot quick replies when the turn fetched open slots", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "toolu_2", name: "get_available_slots", input: { date: "2026-08-02" } },
        ],
      })
      .mockResolvedValueOnce(textTurn("Bukas po ang Aug 2 — piliin ang oras:"));
    executeToolMock.mockResolvedValue({
      ok: true,
      date: "2026-08-02",
      weekday: "Sunday",
      available: true,
      slots: [
        { value: "9AM-12PM", label: "9AM-12PM" },
        { value: "12PM-3PM", label: "12PM-3PM" },
      ],
    });

    await processAgentTurnByMid(MID);
    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.quickReplies).toEqual([
      { title: "9AM-12PM", payload: "SLOT_9AM-12PM" },
      { title: "12PM-3PM", payload: "SLOT_12PM-3PM" },
    ]);
  });

  it("sends a product carousel after the text when the turn searched products (phase 5)", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "toolu_p", name: "search_products", input: { max_price: 1000 } },
        ],
      })
      .mockResolvedValueOnce(textTurn("Heto po ang mga options namin 🌸"));
    executeToolMock.mockResolvedValue({
      ok: true,
      note: "live prices",
      products: [
        {
          productTitle: "Sweet Heart",
          variantId: "gid://shopify/ProductVariant/111",
          pricePhp: 799,
          imageUrl: "https://cdn.shopify.com/sweetheart.jpg",
          url: "https://flowercart.store/products/sweet-heart",
          available: true,
        },
        {
          productTitle: "Autumn Morning",
          variantId: "gid://shopify/ProductVariant/222",
          pricePhp: 799,
          available: false,
        },
      ],
    });

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
    expect(carouselMock).toHaveBeenCalledTimes(1);
    const { psid, elements } = carouselMock.mock.calls[0][0];
    expect(psid).toBe(PSID);
    expect(elements).toHaveLength(2);
    expect(elements[0].title).toBe("Sweet Heart");
    // Merchant decision: WALANG buttons — tap sa picture (default action) ang
    // pupunta sa product page, para kita ang buong photo.
    expect(elements[0].buttons).toBeUndefined();
    expect(elements[0].defaultActionUrl).toBe("https://flowercart.store/products/sweet-heart");
    expect(elements[1].subtitle).toContain("out of stock");
    expect(elements[1].defaultActionUrl).toBeUndefined();
  });

  it("still reports sent when the carousel send fails after the text went out", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "toolu_p2", name: "search_products", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Heto po 🌸"));
    executeToolMock.mockResolvedValue({
      ok: true,
      note: "n",
      products: [
        { productTitle: "X", variantId: "gid://shopify/ProductVariant/1", pricePhp: 1, available: true },
      ],
    });
    carouselMock.mockResolvedValue({ ok: false, error: "Graph API 500" });

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
  });

  it("does not send a carousel when search_products found nothing", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "toolu_p3", name: "search_products", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Walang exact match po."));
    executeToolMock.mockResolvedValue({ ok: true, note: "n", products: [] });

    await processAgentTurnByMid(MID);
    expect(carouselMock).not.toHaveBeenCalled();
  });

  it("prepends the bot disclosure once for a new thread and marks it disclosed", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow({ disclosedBot: false }));
    await processAgentTurnByMid(MID);
    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.text.indexOf("automated")).toBeGreaterThanOrEqual(0);
    expect(sendArgs.text.endsWith("Sige po!")).toBe(true);
    expect(prismaMock.messengerThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { psid: PSID }, data: { disclosedBot: true } }),
    );
  });

  it("returns not_configured when the LLM key is missing (no retry storm)", async () => {
    llmMock.mockResolvedValue({
      ok: false,
      notConfigured: true,
      error: MESSENGER_LLM_NOT_CONFIGURED_MESSAGE,
    });
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("not_configured");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns retryable_failure on an LLM error", async () => {
    llmMock.mockResolvedValue({ ok: false, error: "529 overloaded" });
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("retryable_failure");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns retryable_failure when the Messenger send fails", async () => {
    sendMock.mockResolvedValue({ ok: false, error: "Graph API 500: transient" });
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("retryable_failure");
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
  });

  it("stops a runaway tool loop and still reports retryable_failure", async () => {
    llmMock.mockResolvedValue({
      ok: true,
      stopReason: "tool_use",
      blocks: [{ type: "tool_use", id: "t", name: "resolve_date", input: {} }],
    });
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("retryable_failure");
    expect(llmMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("still reports sent when reply bookkeeping fails after the send", async () => {
    prismaMock.messengerMessage.update.mockRejectedValue(new Error("db hiccup"));
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
  });
});
