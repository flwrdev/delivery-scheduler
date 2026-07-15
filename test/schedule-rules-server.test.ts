import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DELIVERY_SCHEDULE_RULES } from "../app/lib/delivery-availability";

const prismaMock = vi.hoisted(() => ({
  deliveryScheduleConfig: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  getScheduleRules,
  getScheduleRulesWithHealth,
  upsertScheduleRules,
} from "../app/services/schedule-rules.server";

const SHOP = "test-shop.myshopify.com";

function storedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cfg1",
    shop: SHOP,
    timezone: "Asia/Manila",
    cutoffHour: 17,
    prepHours: 1,
    maxDays: 25,
    slotsJson: JSON.stringify([{ display: "Morning", value: "9AM-12PM" }]),
    disabledDatesJson: "[]",
    disabledSlotsJson: "{}",
    slotCapacityJson: "{}",
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getScheduleRules — pure read (PERF-2 fix)", () => {
  it("returns default rules without touching the database when shop is missing", async () => {
    const rules = await getScheduleRules(undefined);
    expect(rules).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES);
    expect(prismaMock.deliveryScheduleConfig.findUnique).not.toHaveBeenCalled();
  });

  it("reads with findUnique and NEVER writes a row as a read side effect", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(null);

    const rules = await getScheduleRules(SHOP);

    expect(rules).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES);
    expect(prismaMock.deliveryScheduleConfig.findUnique).toHaveBeenCalledWith({
      where: { shop: SHOP },
    });
    expect(prismaMock.deliveryScheduleConfig.create).not.toHaveBeenCalled();
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
  });

  it("exposes config health and version through getScheduleRulesWithHealth", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(
      storedRow({ slotsJson: "{corrupt" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getScheduleRulesWithHealth(SHOP);

    expect(result.version).toBe(3);
    expect(result.configHealth.length).toBeGreaterThan(0);
    expect(result.rules.slots).toEqual(DEFAULT_DELIVERY_SCHEDULE_RULES.slots);
    expect(consoleError).toHaveBeenCalled(); // loud, not silent

    consoleError.mockRestore();
  });
});

describe("upsertScheduleRules — strict validation + optimistic version guard", () => {
  it("rejects an invalid patch with field errors and writes nothing", async () => {
    prismaMock.deliveryScheduleConfig.findUnique.mockResolvedValue(storedRow());

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 99 });

    expect(result).toMatchObject({ ok: false, code: "validation" });
    if (!result.ok && result.code === "validation") {
      expect(result.fieldErrors.cutoffHour).toBeTruthy();
    }
    expect(prismaMock.deliveryScheduleConfig.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.deliveryScheduleConfig.create).not.toHaveBeenCalled();
  });

  it("updates with a version guard and increments the version", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(storedRow()) // read current
      .mockResolvedValueOnce(storedRow()) // existence check
      .mockResolvedValueOnce(storedRow({ cutoffHour: 12, version: 4 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.updateMany.mockResolvedValue({ count: 1 });

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(prismaMock.deliveryScheduleConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shop: SHOP, version: 3 },
        data: expect.objectContaining({ cutoffHour: 12, version: 4 }),
      }),
    );
    expect(result).toMatchObject({ ok: true, version: 4 });
    if (result.ok) {
      expect(result.rules.cutoffHour).toBe(12);
    }
  });

  it("returns stale_config with fresh rules when another writer won the race", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(storedRow()) // read current (version 3)
      .mockResolvedValueOnce(storedRow({ version: 4 })) // existence check
      .mockResolvedValueOnce(storedRow({ cutoffHour: 9, version: 4 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.updateMany.mockResolvedValue({ count: 0 });

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 }, { expectedVersion: 3 });

    expect(result).toMatchObject({ ok: false, code: "stale_config", version: 4 });
  });

  it("creates the row on first save (version 1) — reads never created it", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(null) // read current
      .mockResolvedValueOnce(null); // existence check
    prismaMock.deliveryScheduleConfig.create.mockResolvedValue(
      storedRow({ cutoffHour: 12, version: 1 }),
    );

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(prismaMock.deliveryScheduleConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shop: SHOP, cutoffHour: 12, version: 1 }),
      }),
    );
    expect(result).toMatchObject({ ok: true, version: 1 });
  });

  it("maps a create-race unique violation (P2002) to stale_config, not a 500", async () => {
    prismaMock.deliveryScheduleConfig.findUnique
      .mockResolvedValueOnce(null) // read current
      .mockResolvedValueOnce(null) // existence check
      .mockResolvedValueOnce(storedRow({ version: 1 })); // fresh re-read
    prismaMock.deliveryScheduleConfig.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const result = await upsertScheduleRules(SHOP, { cutoffHour: 12 });

    expect(result).toMatchObject({ ok: false, code: "stale_config", version: 1 });
  });
});
