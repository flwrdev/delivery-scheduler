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
  MESSENGER_AGENT_TOOLS: [],
}));
// Fully mocked (no importOriginal): the real module imports shopify.server
// and db.server.
vi.mock("../app/services/messenger-orders.server", () => ({
  confirmMessengerOrder: confirmMock,
  buildOrderSummaryText: summaryMock,
  claimOrderFollowUp: claimFollowUpMock,
}));
// Fully mocked: walang totoong Cloud Tasks calls sa tests.
vi.mock("../app/services/messenger-queue.server", () => ({
  enqueueMessengerFollowUpTask: enqueueFollowUpMock,
}));
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
import {
  messengerFollowUpHours,
  messengerHandbackHours,
  processAgentTurnByMid,
  processOrderFollowUp,
} from "../app/services/messenger-agent.server";

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
  senderActionMock.mockResolvedValue({ ok: true, messageId: "" });
  executeToolMock.mockResolvedValue({ ok: true });
  confirmMock.mockResolvedValue({
    ok: true,
    invoiceUrl: "https://shop.example/invoice/abc",
    draftOrderName: "#D123",
    alreadyCreated: false,
  });
  summaryMock.mockReturnValue("🧾 ORDER SUMMARY (deterministic)");
  claimFollowUpMock.mockResolvedValue({ ok: false, reason: "not_awaiting" });
  enqueueFollowUpMock.mockResolvedValue({ ok: true, taskName: "task-1" });
  prismaMock.messengerMessage.findFirst.mockResolvedValue(customerRow());
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
      { psid: PSID },
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

  it("passes the thread psid to every tool call (stateful tools need it)", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: { phone: "0917" } }],
      })
      .mockResolvedValueOnce(textTurn("Noted po!"));
    await processAgentTurnByMid(MID);
    expect(executeToolMock).toHaveBeenCalledWith(
      "update_order",
      { phone: "0917" },
      expect.any(Date),
      { psid: PSID },
    );
  });
});

describe("processAgentTurnByMid — order summary + Confirm quick replies (phase 6)", () => {
  function readyUpdateResult(orderKey = "key-1") {
    return {
      ok: true,
      state: { status: "awaiting_confirm", productTitle: "Sweet Heart", pricePhp: 799 },
      missing: [],
      readyToConfirm: true,
      orderKey,
      errors: [],
      note: "ready",
    };
  }

  it("appends the DETERMINISTIC summary and attaches Confirm/Baguhin quick replies when ready", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: { phone: "0917..." } }],
      })
      .mockResolvedValueOnce(textTurn("Paki-check po ang summary sa baba 👇"));
    executeToolMock.mockResolvedValue(readyUpdateResult("key-77"));

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");

    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.text).toContain("Paki-check po ang summary");
    expect(sendArgs.text).toContain("🧾 ORDER SUMMARY (deterministic)");
    expect(sendArgs.quickReplies).toEqual([
      { title: "Confirm ✅", payload: "CONFIRM_ORDER_key-77" },
      { title: "Baguhin", payload: "EDIT_ORDER" },
    ]);
    expect(summaryMock).toHaveBeenCalledWith(readyUpdateResult().state);
  });

  it("does not attach Confirm quick replies while details are still missing", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Ano pong address?"));
    executeToolMock.mockResolvedValue({
      ok: true,
      state: { status: "collecting" },
      missing: ["address", "phone"],
      readyToConfirm: false,
      errors: [],
      note: "",
    });

    await processAgentTurnByMid(MID);
    expect(sendMock.mock.calls[0][0].quickReplies).toBeUndefined();
  });

  it("skips the product carousel when the confirm prompt is attached (it would dismiss the buttons)", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "t1", name: "search_products", input: {} },
          { type: "tool_use", id: "t2", name: "update_order", input: {} },
        ],
      })
      .mockResolvedValueOnce(textTurn("Heto po ang summary 👇"));
    executeToolMock.mockImplementation(async (name: string) =>
      name === "search_products"
        ? {
            ok: true,
            note: "n",
            products: [
              { productTitle: "X", variantId: "gid://shopify/ProductVariant/1", pricePhp: 1, available: true },
            ],
          }
        : readyUpdateResult(),
    );

    await processAgentTurnByMid(MID);
    expect(carouselMock).not.toHaveBeenCalled();
    expect(sendMock.mock.calls[0][0].quickReplies?.[0].payload).toBe("CONFIRM_ORDER_key-1");
  });
});

describe("processAgentTurnByMid — deterministic CONFIRM path (phase 6 gate)", () => {
  const CONFIRM_MID = "mid.confirm.1";
  const ORDER_KEY = "3f1c9d2e-1111-2222-3333-444455556666";

  function confirmRow(overrides: Record<string, unknown> = {}) {
    return customerRow({
      mid: CONFIRM_MID,
      bodyJson: JSON.stringify({ text: `[TAP] CONFIRM_ORDER_${ORDER_KEY}` }),
      ...overrides,
    });
  }

  beforeEach(() => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(confirmRow());
  });

  it("creates the order via code — the LLM is never consulted", async () => {
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result).toMatchObject({ status: "sent", replyMid: "mid.bot.new" });
    expect(confirmMock).toHaveBeenCalledWith(PSID, ORDER_KEY);
    expect(llmMock).not.toHaveBeenCalled();

    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.text).toContain("https://shop.example/invoice/abc");
    expect(sendArgs.text).toContain("15 minutes");

    // Standard reply bookkeeping still runs (zero-duplicate guarantee).
    const updateArgs = prismaMock.messengerMessage.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ mid: CONFIRM_MID });
    expect(updateArgs.data.repliedAt).toBeInstanceOf(Date);
  });

  it("GATE: the same CONFIRM mid delivered twice runs the create exactly once", async () => {
    const first = await processAgentTurnByMid(CONFIRM_MID);
    expect(first.status).toBe("sent");

    // The first pass set repliedAt — the duplicate delivery sees it.
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      confirmRow({ repliedAt: new Date(), replyMid: "mid.bot.new" }),
    );
    const second = await processAgentTurnByMid(CONFIRM_MID);
    expect(second.status).toBe("skipped");

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("returns retryable_failure on a transient create failure (Cloud Tasks retries the idempotent path)", async () => {
    confirmMock.mockResolvedValue({ ok: false, code: "transient", error: "ETIMEDOUT" });
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result.status).toBe("retryable_failure");
    expect(sendMock).not.toHaveBeenCalled();
    // repliedAt untouched — the retry may still act.
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
  });

  it("re-sends the SAME invoice link when the create already happened (alreadyCreated replay)", async () => {
    confirmMock.mockResolvedValue({
      ok: true,
      invoiceUrl: "https://shop.example/invoice/abc",
      draftOrderName: "#D123",
      alreadyCreated: true,
    });
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result.status).toBe("sent");
    expect(sendMock.mock.calls[0][0].text).toContain("https://shop.example/invoice/abc");
  });

  it("answers a stale confirm tap with a fixed message and finishes the turn (no retry)", async () => {
    confirmMock.mockResolvedValue({ ok: false, code: "stale_key", error: "stale" });
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result.status).toBe("sent");
    expect(sendMock.mock.calls[0][0].text).toContain("Confirm");
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("answers an incomplete order with a fixed message and finishes the turn", async () => {
    confirmMock.mockResolvedValue({ ok: false, code: "incomplete", error: "missing phone" });
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result.status).toBe("sent");
    expect(sendMock.mock.calls[0][0].text).toContain("kulang");
  });

  it("answers a permanent failure with an apology and finishes the turn (retry cannot help)", async () => {
    confirmMock.mockResolvedValue({ ok: false, code: "failed", error: "Variant gone" });
    const result = await processAgentTurnByMid(CONFIRM_MID);
    expect(result.status).toBe("sent");
    expect(sendMock.mock.calls[0][0].text).toContain("technical issue");
  });

  it("prepends the bot disclosure on a first-contact confirm tap", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow({ disclosedBot: false }));
    await processAgentTurnByMid(CONFIRM_MID);
    expect(sendMock.mock.calls[0][0].text).toContain("automated");
    expect(prismaMock.messengerThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { disclosedBot: true } }),
    );
  });
});

describe("sanitizeMessengerText (Messenger renders plain text only)", () => {
  it("strips markdown bold/italics/links but keeps plain lists and URLs", async () => {
    const { sanitizeMessengerText } = await import("../app/services/messenger-agent.server");
    expect(sanitizeMessengerText("**Sweet Heart** ay available at **P799**.")).toBe(
      "Sweet Heart ay available at P799.",
    );
    expect(sanitizeMessengerText("Bisitahin: *https://flowercart.store* po!")).toBe(
      "Bisitahin: https://flowercart.store po!",
    );
    expect(sanitizeMessengerText("[coverage page](https://flowercart.store/pages/delivery-coverage)")).toBe(
      "coverage page: https://flowercart.store/pages/delivery-coverage",
    );
    expect(sanitizeMessengerText("- 9AM-12PM\n- 12PM-3PM")).toBe("- 9AM-12PM\n- 12PM-3PM");
    expect(sanitizeMessengerText("around P333 po ang estimate")).toBe("around P333 po ang estimate");
  });

  it("replaces em/en dashes with a comma (merchant feedback 2026-08-03)", async () => {
    const { sanitizeMessengerText } = await import("../app/services/messenger-agent.server");
    expect(sanitizeMessengerText("Pwede po kayong mag-pickup kung gusto niyo — sabihin lang po ninyo.")).toBe(
      "Pwede po kayong mag-pickup kung gusto niyo, sabihin lang po ninyo.",
    );
    expect(sanitizeMessengerText("papuntang Mandaluyong—wala pong ganito kaming tool")).toBe(
      "papuntang Mandaluyong, wala pong ganito kaming tool",
    );
    expect(sanitizeMessengerText("9AM–12PM slot")).toBe("9AM, 12PM slot");
    // Hindi nagdodoble ng bantas kapag may comma/period na bago ang dash.
    expect(sanitizeMessengerText("Sige po, — tuloy lang")).toBe("Sige po, tuloy lang");
    // Ang hyphen sa slot values ay HINDI ginagalaw.
    expect(sanitizeMessengerText("- 9AM-12PM\n- 3PM-6PM")).toBe("- 9AM-12PM\n- 3PM-6PM");
  });

  it("is applied to the outgoing reply", async () => {
    llmMock.mockResolvedValue(textTurn("**Autumn Morning** po ay available at **P799**"));
    await processAgentTurnByMid(MID);
    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.text).toContain("Autumn Morning po ay available at P799");
    expect(sendArgs.text).not.toContain("**");
  });
});

describe("processAgentTurnByMid — human takeover mute + auto-handback (phase 7)", () => {
  const HOUR_MS = 60 * 60 * 1000;

  it("skips the turn WITHOUT calling the LLM or sending while humanControl is fresh", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ humanControl: true, humanControlAt: new Date(Date.now() - 1 * HOUR_MS) }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(llmMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    // Zero-duplicate contract untouched: a skipped turn never sets repliedAt.
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
  });

  it("stays muted when humanControl is set but humanControlAt is missing (manual Resume is the recovery)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ humanControl: true, humanControlAt: null }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("mutes the deterministic CONFIRM path too (the human owns the thread)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerRow({ bodyJson: JSON.stringify({ text: "[TAP] CONFIRM_ORDER_key-9" }) }),
    );
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ humanControl: true, humanControlAt: new Date() }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("hands back automatically after the window: clears the flag and RE-DISCLOSES (Meta policy)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({
        humanControl: true,
        humanControlAt: new Date(Date.now() - 7 * HOUR_MS),
        disclosedBot: true, // was disclosed before the takeover — must re-disclose anyway
      }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");

    // Handback write: flag cleared + disclosedBot reset before processing.
    expect(prismaMock.messengerThread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { psid: PSID },
        data: { humanControl: false, humanControlAt: null, disclosedBot: false },
      }),
    );
    // The reply carries the disclosure line again.
    expect(sendMock.mock.calls[0][0].text).toContain("automated");
    // And the send marks the thread disclosed again.
    expect(prismaMock.messengerThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { disclosedBot: true } }),
    );
  });

  it("honors MESSENGER_HANDBACK_HOURS override", async () => {
    vi.stubEnv("MESSENGER_HANDBACK_HOURS", "1");
    try {
      prismaMock.messengerThread.findUnique.mockResolvedValue(
        threadRow({ humanControl: true, humanControlAt: new Date(Date.now() - 2 * HOUR_MS) }),
      );
      const result = await processAgentTurnByMid(MID);
      expect(result.status).toBe("sent");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to 6 hours on a garbage MESSENGER_HANDBACK_HOURS", async () => {
    vi.stubEnv("MESSENGER_HANDBACK_HOURS", "mamaya na");
    try {
      prismaMock.messengerThread.findUnique.mockResolvedValue(
        threadRow({ humanControl: true, humanControlAt: new Date(Date.now() - 2 * HOUR_MS) }),
      );
      const result = await processAgentTurnByMid(MID);
      expect(result.status).toBe("skipped");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still replies (fail-open) when the handback update itself fails", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ humanControl: true, humanControlAt: new Date(Date.now() - 7 * HOUR_MS) }),
    );
    prismaMock.messengerThread.update.mockRejectedValueOnce(new Error("db hiccup"));
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
  });

  it("never processes an operator row itself (role guard)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerRow({ role: "operator" }));
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(llmMock).not.toHaveBeenCalled();
  });
});

describe("operator rows in LLM history (phase 7 — the bot must not contradict the human)", () => {
  it("maps role=operator to an assistant message prefixed [HUMAN AGENT]", async () => {
    prismaMock.messengerMessage.findMany.mockResolvedValue([
      customerRow(), // current customer message (newest first)
      customerRow({
        mid: "m.op.1",
        role: "operator",
        bodyJson: JSON.stringify({ text: "Sige po, ipa-follow-up ko ang order ninyo." }),
        createdAt: new Date(2),
      }),
      customerRow({ mid: "m1", bodyJson: JSON.stringify({ text: "May tao ba dito?" }), createdAt: new Date(1) }),
    ]);
    await processAgentTurnByMid(MID);

    const { system, messages } = llmMock.mock.calls[0][0];
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content[0].text).toBe(
      "[HUMAN AGENT] Sige po, ipa-follow-up ko ang order ninyo.",
    );
    // Bot rows keep their plain text (no prefix), customer rows stay user.
    expect(messages[0].role).toBe("user");
    // The system prompt explains what [HUMAN AGENT] means.
    expect(system).toContain("[HUMAN AGENT]");
    expect(system).toContain("real person");
  });
});

describe("messengerHandbackHours", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 6 when unset or blank", () => {
    expect(messengerHandbackHours()).toBe(6);
    vi.stubEnv("MESSENGER_HANDBACK_HOURS", "   ");
    expect(messengerHandbackHours()).toBe(6);
  });

  it("parses a trimmed numeric override", () => {
    vi.stubEnv("MESSENGER_HANDBACK_HOURS", " 12 ");
    expect(messengerHandbackHours()).toBe(12);
  });

  it("falls back to 6 on garbage, zero, and negatives", () => {
    for (const value of ["abc", "0", "-3", "NaN"]) {
      vi.stubEnv("MESSENGER_HANDBACK_HOURS", value);
      expect(messengerHandbackHours()).toBe(6);
    }
  });
});

describe("typing indicator (phase 8 — sender action before the LLM turn)", () => {
  it("fires typing_on BEFORE the LLM turn on a normal customer message", async () => {
    await processAgentTurnByMid(MID);
    expect(senderActionMock).toHaveBeenCalledTimes(1);
    expect(senderActionMock).toHaveBeenCalledWith({ psid: PSID, action: "typing_on" });
    // Before the LLM, hindi pagkatapos.
    expect(senderActionMock.mock.invocationCallOrder[0]).toBeLessThan(
      llmMock.mock.invocationCallOrder[0],
    );
    // Walang typing_off — Messenger clears it when the reply arrives.
    expect(senderActionMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "typing_off" }),
    );
  });

  it("does NOT fire while the thread is muted (humanControl)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(
      threadRow({ humanControl: true, humanControlAt: new Date() }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("skipped");
    expect(senderActionMock).not.toHaveBeenCalled();
  });

  it("does NOT fire on the deterministic confirm-tap path (fast, walang LLM)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerRow({ bodyJson: JSON.stringify({ text: "[TAP] CONFIRM_ORDER_key-1" }) }),
    );
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
    expect(senderActionMock).not.toHaveBeenCalled();
  });

  it("is best-effort: a failed typing_on never blocks the reply", async () => {
    senderActionMock.mockResolvedValue({ ok: false, error: "Graph API 400" });
    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
  });
});

describe("menu & greeting tap rules in the system prompt (phase 8)", () => {
  it("explains GET_STARTED, the ICEBREAKER_* payloads, and MENU_ORDER", async () => {
    await processAgentTurnByMid(MID);
    const { system } = llmMock.mock.calls[0][0];
    expect(system).toContain("[TAP] GET_STARTED");
    expect(system).toContain("[TAP] ICEBREAKER_PRODUCTS");
    expect(system).toContain("[TAP] ICEBREAKER_FEE");
    expect(system).toContain("[TAP] ICEBREAKER_SAMEDAY");
    expect(system).toContain("[TAP] ICEBREAKER_ORDER");
    expect(system).toContain("MENU_ORDER");
  });

  it("routes order taps to the website while ordering is env-gated OFF, at sa ordering flow kapag ON", async () => {
    await processAgentTurnByMid(MID);
    let { system } = llmMock.mock.calls[0][0];
    expect(system).toContain("ordering in this chat is not available yet");

    vi.stubEnv("MESSENGER_ORDERS_ENABLED", "true");
    try {
      await processAgentTurnByMid(MID);
      ({ system } = llmMock.mock.calls[1][0]);
      expect(system).toContain("start the ordering flow");
      expect(system).not.toContain("ordering in this chat is not available yet");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("phase 9 — product descriptions + typo-tolerant search", () => {
  it("teaches the LLM the INCLUSIONS and fuzzy-confirm rules in the system prompt", async () => {
    await processAgentTurnByMid(MID);
    const { system } = llmMock.mock.calls[0][0];
    expect(system).toContain("INCLUSIONS:");
    expect(system).toContain("BLOOMS");
    expect(system).toContain("NEVER invent inclusions");
    expect(system).toContain("fuzzyMatched=true");
    expect(system).toContain("confirm the product name");
  });

  it("passes the product description through the search_products tool result to the LLM", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t9", name: "search_products", input: { query: "pastel" } }],
      })
      .mockResolvedValueOnce(textTurn("May BLOOMS breakdown po ako 🌸"));
    executeToolMock.mockResolvedValue({
      ok: true,
      note: "n",
      products: [
        {
          productTitle: "Pastel Dreams",
          variantId: "gid://shopify/ProductVariant/9",
          pricePhp: 1499,
          available: true,
          description: "BLOOMS: 10 Pink carnation, 8 Pink rose, 16 White rose",
        },
      ],
    });

    await processAgentTurnByMid(MID);
    // Ang tool_result na naabot ng LLM ay may kasamang description text.
    const secondMessages = llmMock.mock.calls[1][0].messages;
    const toolResult = secondMessages[secondMessages.length - 1].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toContain("BLOOMS: 10 Pink carnation");
  });

  it("passes the description through the get_product_details tool result to the LLM", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "t10",
            name: "get_product_details",
            input: { variant_id: "gid://shopify/ProductVariant/9" },
          },
        ],
      })
      .mockResolvedValueOnce(textTurn("Heto po ang laman 🌸"));
    executeToolMock.mockResolvedValue({
      ok: true,
      product: {
        productTitle: "Pastel Dreams",
        variantId: "gid://shopify/ProductVariant/9",
        pricePhp: 1499,
        available: true,
        description: "BLOOMS: Pastel blue hydrangea, Baby's breath",
      },
    });

    await processAgentTurnByMid(MID);
    const secondMessages = llmMock.mock.calls[1][0].messages;
    const toolResult = secondMessages[secondMessages.length - 1].content[0];
    expect(toolResult.content).toContain("BLOOMS: Pastel blue hydrangea");
  });

  it("relays the fuzzyMatched flag to the LLM so it can confirm the guess", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "t11", name: "search_products", input: { query: "pastil dream" } },
        ],
      })
      .mockResolvedValueOnce(textTurn("Ito po ba ang ibig niyong sabihin — Pastel Dreams?"));
    executeToolMock.mockResolvedValue({
      ok: true,
      note: "n",
      fuzzyMatched: true,
      products: [
        {
          productTitle: "Pastel Dreams",
          variantId: "gid://shopify/ProductVariant/9",
          pricePhp: 1499,
          available: true,
        },
      ],
    });

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
    const secondMessages = llmMock.mock.calls[1][0].messages;
    const toolResult = secondMessages[secondMessages.length - 1].content[0];
    expect(toolResult.content).toContain('"fuzzyMatched":true');
  });
});

describe("phase-6 ordering env gate", () => {
  it("hides the ORDERING prompt + update_order tool while MESSENGER_ORDERS_ENABLED is unset", async () => {
    await processAgentTurnByMid(MID);
    const { system, tools } = llmMock.mock.calls[0][0];
    expect(system).toContain("cannot take orders or payments yet");
    expect(system).not.toContain("ORDERING (you CAN take orders");
    expect((tools ?? []).map((t: { name: string }) => t.name)).not.toContain("update_order");
  });

  it("enables the ORDERING prompt + update_order tool when the flag is true", async () => {
    vi.stubEnv("MESSENGER_ORDERS_ENABLED", "true");
    try {
      await processAgentTurnByMid(MID);
      const { system } = llmMock.mock.calls[0][0];
      expect(system).toContain("ORDERING (you CAN take orders");
      expect(system).not.toContain("cannot take orders or payments yet");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Add-on upsell + abandoned-order follow-up (2026-08-03)
// ---------------------------------------------------------------------------

describe("processAgentTurnByMid — add-on upsell quick replies", () => {
  it("attaches the add-on category quick replies when missing[0] is add_on", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: { phone: "0917" } }],
      })
      .mockResolvedValueOnce(textTurn("Gusto niyo po bang samahan ng add-on? 🧸"));
    executeToolMock.mockResolvedValue({
      ok: true,
      state: { status: "collecting" },
      missing: ["add_on"],
      readyToConfirm: false,
      errors: [],
      note: "offer the add-on",
    });

    await processAgentTurnByMid(MID);
    expect(sendMock.mock.calls[0][0].quickReplies).toEqual([
      { title: "🧸 Bear", payload: "ADDON_BEAR" },
      { title: "🍫 Chocolates", payload: "ADDON_CHOCOLATES" },
      { title: "🎈 Balloon", payload: "ADDON_BALLOON" },
      { title: "Hindi na po", payload: "ADDON_NONE" },
    ]);
  });

  it("does NOT attach add-on quick replies when a different field is next", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Ano pong address?"));
    executeToolMock.mockResolvedValue({
      ok: true,
      state: { status: "collecting" },
      missing: ["address", "phone", "add_on"],
      readyToConfirm: false,
      errors: [],
      note: "",
    });

    await processAgentTurnByMid(MID);
    expect(sendMock.mock.calls[0][0].quickReplies).toBeUndefined();
  });

  it("system prompt carries the ADDON tap rules when ordering is enabled", async () => {
    vi.stubEnv("MESSENGER_ORDERS_ENABLED", "true");
    await processAgentTurnByMid(MID);
    const { system } = llmMock.mock.calls[0][0];
    expect(system).toContain("ADDON_BEAR");
    expect(system).toContain("ADDON_NONE");
    expect(system).toContain("add_on_variant_id");
    vi.unstubAllEnvs();
  });
});

describe("processAgentTurnByMid — abandoned-order follow-up scheduling", () => {
  function readyUpdateResult(orderKey: string) {
    return {
      ok: true,
      state: { status: "awaiting_confirm", productTitle: "Sweet Heart", pricePhp: 799 },
      missing: [],
      readyToConfirm: true,
      orderKey,
      errors: [],
      note: "ready",
    };
  }

  it("schedules ONE delayed follow-up task after the summary is sent", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Paki-check po ang summary 👇"));
    executeToolMock.mockResolvedValue(readyUpdateResult("key-fu-1"));

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
    expect(enqueueFollowUpMock).toHaveBeenCalledTimes(1);
    expect(enqueueFollowUpMock).toHaveBeenCalledWith({
      psid: PSID,
      orderKey: "key-fu-1",
      delaySeconds: 3 * 3600,
    });
  });

  it("does NOT schedule a follow-up on a non-summary turn", async () => {
    await processAgentTurnByMid(MID);
    expect(enqueueFollowUpMock).not.toHaveBeenCalled();
  });

  it("a failed enqueue never fails the turn", async () => {
    llmMock
      .mockResolvedValueOnce({
        ok: true,
        stopReason: "tool_use",
        blocks: [{ type: "tool_use", id: "t1", name: "update_order", input: {} }],
      })
      .mockResolvedValueOnce(textTurn("Summary 👇"));
    executeToolMock.mockResolvedValue(readyUpdateResult("key-fu-2"));
    enqueueFollowUpMock.mockRejectedValue(new Error("tasks down"));

    const result = await processAgentTurnByMid(MID);
    expect(result.status).toBe("sent");
  });

  it("messengerFollowUpHours: default 3, env override, 0 disables, garbage falls back", () => {
    expect(messengerFollowUpHours()).toBe(3);
    vi.stubEnv("MESSENGER_FOLLOWUP_HOURS", "6");
    expect(messengerFollowUpHours()).toBe(6);
    vi.stubEnv("MESSENGER_FOLLOWUP_HOURS", "0");
    expect(messengerFollowUpHours()).toBe(0);
    vi.stubEnv("MESSENGER_FOLLOWUP_HOURS", "abc");
    expect(messengerFollowUpHours()).toBe(3);
    vi.unstubAllEnvs();
  });
});

describe("processOrderFollowUp — delayed reminder guards (mark-before-send)", () => {
  const FU_KEY = "key-followup-1";
  const FU_NOW = new Date("2026-08-03T10:00:00Z");

  function claimedState() {
    return {
      ok: true as const,
      state: {
        status: "awaiting_confirm" as const,
        productTitle: "Sweet Heart",
        pricePhp: 799,
        deliveryDate: "2026-08-05",
        timeSlot: "9AM-12PM",
        orderKey: FU_KEY,
        followUpSentAt: FU_NOW.toISOString(),
      },
    };
  }

  it("sends the deterministic reminder with Confirm quick replies when the claim succeeds", async () => {
    // Huling customer message: 3h ago — lampas sa active-chat window, loob ng 20h.
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 3 * 3600 * 1000) }),
    );
    claimFollowUpMock.mockResolvedValue(claimedState());

    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("sent");
    expect(claimFollowUpMock).toHaveBeenCalledWith(PSID, FU_KEY);

    const sendArgs = sendMock.mock.calls[0][0];
    expect(sendArgs.psid).toBe(PSID);
    expect(sendArgs.text).toContain("Naka-reserve pa po");
    expect(sendArgs.text).toContain("Sweet Heart");
    expect(sendArgs.quickReplies).toEqual([
      { title: "Confirm ✅", payload: `CONFIRM_ORDER_${FU_KEY}` },
      { title: "Baguhin", payload: "EDIT_ORDER" },
    ]);

    // Bot row recorded para buo ang history.
    const botCreate = prismaMock.messengerMessage.create.mock.calls.find(
      ([args]) => args.data.role === "bot",
    );
    expect(botCreate).toBeTruthy();
  });

  it("skips while humanControl is on (never claims)", async () => {
    prismaMock.messengerThread.findUnique.mockResolvedValue(threadRow({ humanControl: true }));
    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("skipped");
    expect(claimFollowUpMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when the conversation is still active (last customer message < 45 min)", async () => {
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 10 * 60 * 1000) }),
    );
    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("skipped");
    expect(claimFollowUpMock).not.toHaveBeenCalled();
  });

  it("test mode (short MESSENGER_FOLLOWUP_HOURS) scales the active-chat guard to half the delay", async () => {
    // 0.05h delay → 90s guard: ang 3-min-old customer message ay hindi na "active".
    vi.stubEnv("MESSENGER_FOLLOWUP_HOURS", "0.05");
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 3 * 60 * 1000) }),
    );
    claimFollowUpMock.mockResolvedValue(claimedState());

    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("sent");
    vi.unstubAllEnvs();
  });

  it("skips outside the Meta messaging window (last customer message > 20h)", async () => {
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 22 * 3600 * 1000) }),
    );
    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("skipped");
    expect(claimFollowUpMock).not.toHaveBeenCalled();
  });

  it("skips when the claim says already_sent / not_awaiting / stale_key", async () => {
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 3 * 3600 * 1000) }),
    );
    for (const reason of ["already_sent", "not_awaiting", "stale_key"] as const) {
      claimFollowUpMock.mockResolvedValue({ ok: false, reason });
      const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
      expect(result.status).toBe("skipped");
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a send failure AFTER the claim gives up (zero-duplicate over guaranteed delivery)", async () => {
    prismaMock.messengerMessage.findFirst.mockResolvedValue(
      customerRow({ createdAt: new Date(FU_NOW.getTime() - 3 * 3600 * 1000) }),
    );
    claimFollowUpMock.mockResolvedValue(claimedState());
    sendMock.mockResolvedValue({ ok: false, error: "Graph API 500" });

    const result = await processOrderFollowUp(PSID, FU_KEY, FU_NOW);
    expect(result.status).toBe("skipped");
  });
});
