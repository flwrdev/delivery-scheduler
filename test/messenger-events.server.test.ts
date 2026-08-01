import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: { upsert: vi.fn() },
    messengerMessage: {
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  deleteRecordedMessage,
  recordInboundTextMessage,
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

describe("deleteRecordedMessage", () => {
  it("deletes by mid and never throws", async () => {
    await deleteRecordedMessage(MID);
    expect(prismaMock.messengerMessage.delete).toHaveBeenCalledWith({ where: { mid: MID } });

    prismaMock.messengerMessage.delete.mockRejectedValue(new Error("gone"));
    await expect(deleteRecordedMessage(MID)).resolves.toBeUndefined();
  });
});
