import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { upsert: vi.fn() },
    messengerMessage: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  deleteRecordedMessage,
  isKnownMessageMid,
  recordInboundTextMessage,
  recordOperatorEchoMessage,
} from "../app/services/messenger-events.server";

const PSID = "24681357900001";
const MID = "mid.customer.1";

beforeEach(() => {
  prismaMock.messengerThread.upsert.mockResolvedValue({ psid: PSID });
  prismaMock.messengerMessage.create.mockResolvedValue({ mid: MID });
  prismaMock.messengerMessage.delete.mockResolvedValue({ mid: MID });
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

describe("isKnownMessageMid (phase 7 echo-discriminator fallback)", () => {
  it("returns true when the mid is already recorded (bot-sent echo)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue({ mid: MID });
    await expect(isKnownMessageMid(MID)).resolves.toBe(true);
    expect(prismaMock.messengerMessage.findUnique).toHaveBeenCalledWith({
      where: { mid: MID },
      select: { mid: true },
    });
  });

  it("returns false when the mid is unknown (operator-typed echo)", async () => {
    prismaMock.messengerMessage.findUnique.mockResolvedValue(null);
    await expect(isKnownMessageMid(MID)).resolves.toBe(false);
  });

  it("propagates DB failures (the webhook catches and skips — never a blind takeover)", async () => {
    prismaMock.messengerMessage.findUnique.mockRejectedValue(new Error("db down"));
    await expect(isKnownMessageMid(MID)).rejects.toThrow("db down");
  });
});

describe("recordOperatorEchoMessage (phase 7 human takeover)", () => {
  const ECHO_MID = "m.echo.human.1";

  it("sets humanControl + humanControlAt on the thread and records an operator row", async () => {
    const result = await recordOperatorEchoMessage({
      psid: PSID,
      mid: ECHO_MID,
      text: "Ako na bahala dito",
    });

    expect(result).toEqual({ status: "new" });
    const upsertArgs = prismaMock.messengerThread.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ psid: PSID });
    expect(upsertArgs.create.humanControl).toBe(true);
    expect(upsertArgs.create.humanControlAt).toBeInstanceOf(Date);
    expect(upsertArgs.update.humanControl).toBe(true);
    expect(upsertArgs.update.humanControlAt).toBeInstanceOf(Date);
    // The takeover must NOT bump lastCustomerAt (24h-window tracking is
    // customer messages only).
    expect(upsertArgs.update.lastCustomerAt).toBeUndefined();

    const createArgs = prismaMock.messengerMessage.create.mock.calls[0][0];
    expect(createArgs.data.role).toBe("operator");
    expect(createArgs.data.mid).toBe(ECHO_MID);
    expect(JSON.parse(createArgs.data.bodyJson)).toEqual({ text: "Ako na bahala dito" });
  });

  it("still refreshes humanControlAt on a redelivered echo mid (duplicate row)", async () => {
    prismaMock.messengerMessage.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const result = await recordOperatorEchoMessage({ psid: PSID, mid: ECHO_MID, text: "x" });
    expect(result).toEqual({ status: "duplicate" });
    // The upsert ran BEFORE the create — the handback window still refreshed.
    expect(prismaMock.messengerThread.upsert).toHaveBeenCalledTimes(1);
  });

  it("returns error (never throws) on other database failures", async () => {
    prismaMock.messengerThread.upsert.mockRejectedValue(new Error("db down"));
    const result = await recordOperatorEchoMessage({ psid: PSID, mid: ECHO_MID, text: "x" });
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
