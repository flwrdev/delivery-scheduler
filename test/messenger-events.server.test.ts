import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, sendMock } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { upsert: vi.fn() },
    messengerMessage: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  sendMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/services/messenger-send.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/services/messenger-send.server")>();
  return {
    ...original,
    sendMessengerTextMessage: sendMock,
  };
});

import { MESSENGER_NOT_CONFIGURED_MESSAGE } from "../app/services/messenger-send.server";
import {
  deleteRecordedMessage,
  processEchoByMid,
  recordInboundTextMessage,
} from "../app/services/messenger-events.server";

const PSID = "24681357900001";
const MID = "mid.customer.1";

function customerMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmid1",
    psid: PSID,
    role: "customer",
    bodyJson: JSON.stringify({ text: "hello" }),
    mid: MID,
    repliedAt: null,
    replyMid: null,
    createdAt: new Date("2026-08-01T04:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock.messengerThread.upsert.mockResolvedValue({ psid: PSID });
  prismaMock.messengerMessage.create.mockResolvedValue(customerMessageRow());
  prismaMock.messengerMessage.findUnique.mockResolvedValue(null);
  prismaMock.messengerMessage.update.mockResolvedValue(customerMessageRow());
  prismaMock.messengerMessage.delete.mockResolvedValue(customerMessageRow());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordInboundTextMessage", () => {
  it("upserts the thread and creates a customer message row", async () => {
    const result = await recordInboundTextMessage({ psid: PSID, mid: MID, text: "hello" });

    expect(result).toEqual({ status: "new" });
    expect(prismaMock.messengerThread.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = prismaMock.messengerThread.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ psid: PSID });
    expect(upsertArgs.create.psid).toBe(PSID);
    expect(upsertArgs.create.lastCustomerAt).toBeInstanceOf(Date);
    expect(upsertArgs.update.lastCustomerAt).toBeInstanceOf(Date);

    const createArgs = prismaMock.messengerMessage.create.mock.calls[0][0];
    expect(createArgs.data.psid).toBe(PSID);
    expect(createArgs.data.role).toBe("customer");
    expect(createArgs.data.mid).toBe(MID);
    expect(JSON.parse(createArgs.data.bodyJson)).toEqual({ text: "hello" });
  });

  it("returns duplicate on a mid unique violation (Meta redelivery)", async () => {
    prismaMock.messengerMessage.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const result = await recordInboundTextMessage({ psid: PSID, mid: MID, text: "hello" });
    expect(result).toEqual({ status: "duplicate" });
  });

  it("returns error (never throws) on other database failures", async () => {
    prismaMock.messengerThread.upsert.mockRejectedValue(new Error("db down"));

    const result = await recordInboundTextMessage({ psid: PSID, mid: MID, text: "hello" });
    expect(result.status).toBe("error");
  });
});

describe("deleteRecordedMessage", () => {
  it("deletes by mid and never throws", async () => {
    await deleteRecordedMessage(MID);
    expect(prismaMock.messengerMessage.delete).toHaveBeenCalledWith({ where: { mid: MID } });

    prismaMock.messengerMessage.delete.mockRejectedValue(new Error("gone"));
    await expect(deleteRecordedMessage(MID)).resolves.toBeUndefined();
  });
});

describe("processEchoByMid", () => {
  it("returns not_found for an unknown mid without sending", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(null);

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("not_found");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips an already-replied message without sending (retry idempotency)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerMessageRow({ repliedAt: new Date(), replyMid: "mid.bot.old" }),
    );

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips non-customer rows without sending", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerMessageRow({ role: "bot", mid: "mid.bot.1" }),
    );

    const result = await processEchoByMid("mid.bot.1");
    expect(result.status).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends the echo, marks repliedAt/replyMid, and records the bot mid", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerMessageRow());
    sendMock.mockResolvedValue({ ok: true, messageId: "mid.bot.new" });

    const result = await processEchoByMid(MID);

    expect(result).toMatchObject({ status: "sent", replyMid: "mid.bot.new" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ psid: PSID, text: "Echo: hello" });

    const updateArgs = prismaMock.messengerMessage.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ mid: MID });
    expect(updateArgs.data.repliedAt).toBeInstanceOf(Date);
    expect(updateArgs.data.replyMid).toBe("mid.bot.new");

    // Bot-sent mids are recorded (phase 7 echo-matching depends on this).
    const botCreate = prismaMock.messengerMessage.create.mock.calls.find(
      ([args]) => args.data.role === "bot",
    );
    expect(botCreate).toBeDefined();
    expect(botCreate?.[0].data.mid).toBe("mid.bot.new");
    expect(botCreate?.[0].data.psid).toBe(PSID);
  });

  it("truncates the echo to 2000 chars", async () => {
    const longText = "x".repeat(2500);
    prismaMock.messengerMessage.findUnique.mockResolvedValue(
      customerMessageRow({ bodyJson: JSON.stringify({ text: longText }) }),
    );
    sendMock.mockResolvedValue({ ok: true, messageId: "mid.bot.long" });

    await processEchoByMid(MID);

    const sentText = sendMock.mock.calls[0][0].text as string;
    expect(sentText.length).toBe(2000);
    expect(sentText.startsWith("Echo: x")).toBe(true);
  });

  it("returns not_configured (no retry) when sending is not configured, without marking replied", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerMessageRow());
    sendMock.mockResolvedValue({ ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("not_configured");
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
  });

  it("returns retryable_failure on other send failures, without marking replied", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerMessageRow());
    sendMock.mockResolvedValue({ ok: false, error: "Graph API 500: something transient" });

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("retryable_failure");
    expect(prismaMock.messengerMessage.update).not.toHaveBeenCalled();
  });

  it("returns retryable_failure when the send throws", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerMessageRow());
    sendMock.mockRejectedValue(new Error("network"));

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("retryable_failure");
  });

  it("still reports sent when recording the bot row fails after a successful send", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(customerMessageRow());
    sendMock.mockResolvedValue({ ok: true, messageId: "mid.bot.new" });
    prismaMock.messengerMessage.create.mockRejectedValue(new Error("db hiccup"));

    const result = await processEchoByMid(MID);
    expect(result.status).toBe("sent");
  });
});
