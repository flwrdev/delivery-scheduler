import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rulesDetailedMock,
  evaluateMock,
  syncMetafieldsMock,
  syncTagMock,
  codFeeMock,
} = vi.hoisted(() => ({
  rulesDetailedMock: vi.fn(),
  evaluateMock: vi.fn(),
  syncMetafieldsMock: vi.fn(),
  syncTagMock: vi.fn(),
  codFeeMock: vi.fn(),
}));

vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesDetailed: rulesDetailedMock,
}));

vi.mock("../app/services/order-delivery-metafields.server", () => ({
  evaluateDeliverySyncStatus: evaluateMock,
  syncOrderDeliveryMetafields: syncMetafieldsMock,
  syncOrderDeliveryScheduleTag: syncTagMock,
}));

vi.mock("../app/services/cod-fee.server", () => ({
  applyCodFeeToOrder: codFeeMock,
}));

import {
  syncOrderDelivery,
  type OrderDeliverySyncInput,
} from "../app/services/order-delivery-sync.server";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_GID = "gid://shopify/Order/111";
const CHECKOUT = new Date("2026-08-26T08:50:00.000Z");
const RULES = { timezone: "Asia/Manila" };
const admin = { graphql: vi.fn() };

function input(overrides: Partial<OrderDeliverySyncInput> = {}): OrderDeliverySyncInput {
  return {
    shop: SHOP,
    orderId: ORDER_GID,
    deliveryDate: "2026-08-27",
    timeSlot: "9AM-12PM",
    checkoutTime: CHECKOUT,
    needsCodFee: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rulesDetailedMock.mockResolvedValue({ rules: RULES, countsMeta: { status: "ok" } });
  evaluateMock.mockReturnValue("ok");
  syncMetafieldsMock.mockResolvedValue({ ok: true, skipped: false, metafieldCount: 5, errors: [] });
  syncTagMock.mockResolvedValue({ ok: true, skipped: false, scheduleTags: [], removedTags: [], errors: [] });
  codFeeMock.mockResolvedValue({ ok: true, skipped: false, errors: [] });
});

describe("syncOrderDelivery", () => {
  it("writes metafields and the schedule tag, excluding the order from its own slot count", async () => {
    const result = await syncOrderDelivery(admin, input());
    expect(result).toEqual({ ok: true, errors: [] });
    expect(rulesDetailedMock).toHaveBeenCalledWith(SHOP, admin, { excludeOrderId: ORDER_GID });
    expect(syncTagMock).toHaveBeenCalledWith(admin, {
      orderId: ORDER_GID,
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
    });
    expect(codFeeMock).not.toHaveBeenCalled();
  });

  it("validates with the order's checkout time and passes the verdict as a flag", async () => {
    await syncOrderDelivery(admin, input());
    expect(evaluateMock).toHaveBeenCalledWith(RULES, "2026-08-27", "9AM-12PM", CHECKOUT);
    expect(syncMetafieldsMock).toHaveBeenCalledWith(admin, {
      orderId: ORDER_GID,
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      syncStatus: "ok",
    });
  });

  it("still writes the delivery data when validation flags attention", async () => {
    evaluateMock.mockReturnValue("attention:cutoff");
    const result = await syncOrderDelivery(admin, input());
    expect(result.ok).toBe(true);
    expect(syncMetafieldsMock).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ syncStatus: "attention:cutoff" }),
    );
  });

  it("runs every step even when one fails, and reports the failure", async () => {
    syncMetafieldsMock.mockResolvedValue({ ok: false, skipped: false, metafieldCount: 0, errors: ["boom"] });
    const result = await syncOrderDelivery(admin, input({ needsCodFee: true }));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["metafields: boom"]);
    expect(syncTagMock).toHaveBeenCalledTimes(1);
    expect(codFeeMock).toHaveBeenCalledTimes(1);
  });

  it("reports thrown errors per step", async () => {
    rulesDetailedMock.mockRejectedValue(new Error("rules down"));
    syncTagMock.mockRejectedValue(new Error("network"));
    const result = await syncOrderDelivery(admin, input());
    expect(result).toEqual({ ok: false, errors: ["metafields: rules down", "tags: network"] });
  });

  it("runs only the COD step for a COD order without delivery attributes; skipped is success", async () => {
    codFeeMock.mockResolvedValue({ ok: true, skipped: true, reason: "fee already on order", errors: [] });
    const result = await syncOrderDelivery(
      admin,
      input({ deliveryDate: null, timeSlot: null, needsCodFee: true }),
    );
    expect(result.ok).toBe(true);
    expect(codFeeMock).toHaveBeenCalledWith(admin, { orderId: ORDER_GID });
    expect(rulesDetailedMock).not.toHaveBeenCalled();
    expect(syncTagMock).not.toHaveBeenCalled();
  });
});
