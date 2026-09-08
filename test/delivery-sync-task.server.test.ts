import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-22 Phase A: the delivery-sync work queue's three load-bearing behaviors —
// the ATOMIC CLAIM (no double-processing), the PER-STEP LEDGER (a partial sync
// resumes exactly where it stopped), and the FROZEN VALIDATION CLOCK (a retry
// validates with the order's checkoutTime, never "now" — a paid order can
// never become "past cutoff" because its sync was delayed). Every seam is
// mocked; no DB / Shopify / Cloud Tasks.

const {
  upsertMock,
  updateManyMock,
  updateMock,
  findUniqueMock,
  findManyMock,
  countMock,
  adminMock,
  rulesDetailedMock,
  evaluateMock,
  syncMetafieldsMock,
  syncTagMock,
  codFeeMock,
  enqueueMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  updateManyMock: vi.fn(),
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  adminMock: vi.fn(),
  rulesDetailedMock: vi.fn(),
  evaluateMock: vi.fn(),
  syncMetafieldsMock: vi.fn(),
  syncTagMock: vi.fn(),
  codFeeMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    deliverySyncTask: {
      upsert: upsertMock,
      updateMany: updateManyMock,
      update: updateMock,
      findUnique: findUniqueMock,
      findMany: findManyMock,
      count: countMock,
    },
  },
}));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
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

vi.mock("../app/services/ops-queue.server", () => ({
  enqueueDeliverySyncTask: enqueueMock,
}));

import {
  DELIVERY_SYNC_MAX_ATTEMPTS,
  claimDeliverySyncTask,
  deliverySyncBackoffMs,
  getDeliverySyncIssues,
  processDeliverySyncTask,
  retryDeliverySyncIssues,
  upsertDeliverySyncTask,
} from "../app/services/delivery-sync-task.server";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_GID = "gid://shopify/Order/111";
const CHECKOUT = new Date("2026-08-26T08:50:00.000Z");
const RULES = { timezone: "Asia/Manila" };

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    shop: SHOP,
    shopifyOrderId: ORDER_GID,
    orderName: "#1046",
    deliveryDate: "2026-08-27",
    timeSlot: "9AM-12PM",
    checkoutTime: CHECKOUT,
    needsCodFee: false,
    metafieldsDone: false,
    tagsDone: false,
    codFeeDone: true,
    status: "pending",
    lockedAt: null,
    attempts: 0,
    nextAttemptAt: new Date(0),
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    doneAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockResolvedValue({ id: "task-1" });
  updateManyMock.mockResolvedValue({ count: 1 });
  updateMock.mockResolvedValue({});
  adminMock.mockResolvedValue({ admin: { graphql: vi.fn() } });
  rulesDetailedMock.mockResolvedValue({ rules: RULES, countsMeta: { status: "ok" } });
  evaluateMock.mockReturnValue("ok");
  syncMetafieldsMock.mockResolvedValue({ ok: true, skipped: false, metafieldCount: 5, errors: [] });
  syncTagMock.mockResolvedValue({ ok: true, skipped: false, scheduleTags: [], removedTags: [], errors: [] });
  codFeeMock.mockResolvedValue({ ok: true, skipped: false, errors: [] });
  enqueueMock.mockResolvedValue({ ok: true, taskName: "t" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("upsertDeliverySyncTask", () => {
  it("creates a delivery task with only the COD step pre-done", async () => {
    await upsertDeliverySyncTask({
      shop: SHOP,
      shopifyOrderId: ORDER_GID,
      orderName: "#1046",
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      checkoutTime: CHECKOUT,
      needsCodFee: false,
    });
    const args = upsertMock.mock.calls[0][0];
    expect(args.where).toEqual({
      shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: ORDER_GID },
    });
    expect(args.create).toMatchObject({
      metafieldsDone: false,
      tagsDone: false,
      codFeeDone: true,
      checkoutTime: CHECKOUT,
    });
  });

  it("creates a COD-only task with the delivery steps pre-done", async () => {
    await upsertDeliverySyncTask({
      shop: SHOP,
      shopifyOrderId: ORDER_GID,
      orderName: null,
      deliveryDate: null,
      timeSlot: null,
      checkoutTime: CHECKOUT,
      needsCodFee: true,
    });
    expect(upsertMock.mock.calls[0][0].create).toMatchObject({
      metafieldsDone: true,
      tagsDone: true,
      codFeeDone: false,
    });
  });

  it("never clobbers progress on a webhook redelivery — update carries only orderName", async () => {
    await upsertDeliverySyncTask({
      shop: SHOP,
      shopifyOrderId: ORDER_GID,
      orderName: "#1046",
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      checkoutTime: CHECKOUT,
      needsCodFee: true,
    });
    expect(upsertMock.mock.calls[0][0].update).toEqual({ orderName: "#1046" });
  });
});

describe("claimDeliverySyncTask — the atomic claim", () => {
  it("check and take are ONE conditional update: pending + unclaimed-or-stale", async () => {
    const now = new Date("2026-08-26T10:00:00Z");
    updateManyMock.mockResolvedValue({ count: 1 });
    expect(await claimDeliverySyncTask("task-1", now)).toBe(true);
    const args = updateManyMock.mock.calls[0][0];
    expect(args.where.id).toBe("task-1");
    expect(args.where.status).toBe("pending");
    expect(args.where.OR).toEqual([
      { lockedAt: null },
      { lockedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) } },
    ]);
    expect(args.data).toEqual({ lockedAt: now });
  });

  it("count 0 means another worker won — claim returns false", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    expect(await claimDeliverySyncTask("task-1")).toBe(false);
  });
});

describe("processDeliverySyncTask", () => {
  it("returns not_found / terminal without claiming", async () => {
    findUniqueMock.mockResolvedValue(null);
    expect(await processDeliverySyncTask("nope")).toEqual({ status: "not_found" });

    findUniqueMock.mockResolvedValue(baseRow({ status: "done" }));
    expect(await processDeliverySyncTask("task-1")).toEqual({ status: "terminal" });

    findUniqueMock.mockResolvedValue(baseRow({ status: "failed" }));
    expect(await processDeliverySyncTask("task-1")).toEqual({ status: "terminal" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("walks away untouched when another worker holds the lease", async () => {
    findUniqueMock.mockResolvedValue(baseRow());
    updateManyMock.mockResolvedValue({ count: 0 });
    expect(await processDeliverySyncTask("task-1")).toEqual({ status: "locked" });
    expect(adminMock).not.toHaveBeenCalled();
    expect(syncMetafieldsMock).not.toHaveBeenCalled();
  });

  it("happy path runs both steps, checkpoints each, and finishes done", async () => {
    findUniqueMock.mockResolvedValue(baseRow());
    const result = await processDeliverySyncTask("task-1");
    expect(result).toEqual({ status: "done" });
    // Per-step checkpoints, then the terminal update.
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { metafieldsDone: true },
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { tagsDone: true },
    });
    const finalArgs = updateMock.mock.calls.at(-1)![0];
    expect(finalArgs.data).toMatchObject({ status: "done", lockedAt: null, lastError: null });
  });

  it("THE FROZEN CLOCK: validation runs with the row's checkoutTime, never now", async () => {
    findUniqueMock.mockResolvedValue(baseRow());
    await processDeliverySyncTask("task-1");
    expect(evaluateMock).toHaveBeenCalledWith(RULES, "2026-08-27", "9AM-12PM", CHECKOUT);
    // And its verdict is a FLAG handed to the metafield write — never a gate.
    expect(syncMetafieldsMock).toHaveBeenCalledWith(expect.anything(), {
      orderId: ORDER_GID,
      deliveryDate: "2026-08-27",
      timeSlot: "9AM-12PM",
      syncStatus: "ok",
    });
  });

  it("an attention verdict still syncs (D4: flag, not gate)", async () => {
    evaluateMock.mockReturnValue("attention:cutoff");
    findUniqueMock.mockResolvedValue(baseRow());
    const result = await processDeliverySyncTask("task-1");
    expect(result).toEqual({ status: "done" });
    expect(syncMetafieldsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ syncStatus: "attention:cutoff" }),
    );
  });

  it("partial failure checkpoints the succeeding step and schedules a retry", async () => {
    findUniqueMock.mockResolvedValue(baseRow());
    syncMetafieldsMock.mockResolvedValue({ ok: false, skipped: false, metafieldCount: 0, errors: ["boom"] });
    const result = await processDeliverySyncTask("task-1");
    expect(result.status).toBe("retry");
    expect((result as { error: string }).error).toContain("metafields: boom");
    // tags still ran and was checkpointed — S5's partial state is recorded.
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { tagsDone: true },
    });
    const finalArgs = updateMock.mock.calls.at(-1)![0];
    expect(finalArgs.data).toMatchObject({ attempts: 1, lockedAt: null });
    expect(finalArgs.data.nextAttemptAt).toBeInstanceOf(Date);
    expect(finalArgs.data.status).toBeUndefined(); // stays pending
  });

  it("a checkpointed retry skips the already-done step entirely", async () => {
    findUniqueMock.mockResolvedValue(baseRow({ metafieldsDone: true }));
    const result = await processDeliverySyncTask("task-1");
    expect(result).toEqual({ status: "done" });
    expect(rulesDetailedMock).not.toHaveBeenCalled();
    expect(syncMetafieldsMock).not.toHaveBeenCalled();
    expect(syncTagMock).toHaveBeenCalledTimes(1);
  });

  it("fails terminally at the attempts cap", async () => {
    findUniqueMock.mockResolvedValue(baseRow({ attempts: DELIVERY_SYNC_MAX_ATTEMPTS - 1 }));
    syncMetafieldsMock.mockRejectedValue(new Error("network"));
    syncTagMock.mockRejectedValue(new Error("network"));
    const result = await processDeliverySyncTask("task-1");
    expect(result.status).toBe("failed");
    const finalArgs = updateMock.mock.calls.at(-1)![0];
    expect(finalArgs.data).toMatchObject({ status: "failed", lockedAt: null });
  });

  it("no offline session is terminal, not a retry burn", async () => {
    findUniqueMock.mockResolvedValue(baseRow());
    adminMock.mockRejectedValue(new Error("no session"));
    const result = await processDeliverySyncTask("task-1");
    expect(result.status).toBe("failed");
    expect(syncMetafieldsMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "failed", lockedAt: null }),
    });
  });

  it("runs the COD step on a COD-only task and treats skipped as success", async () => {
    findUniqueMock.mockResolvedValue(
      baseRow({
        deliveryDate: null,
        timeSlot: null,
        metafieldsDone: true,
        tagsDone: true,
        needsCodFee: true,
        codFeeDone: false,
      }),
    );
    codFeeMock.mockResolvedValue({ ok: true, skipped: true, reason: "already applied", errors: [] });
    const result = await processDeliverySyncTask("task-1");
    expect(result).toEqual({ status: "done" });
    expect(codFeeMock).toHaveBeenCalledWith(expect.anything(), { orderId: ORDER_GID });
    expect(rulesDetailedMock).not.toHaveBeenCalled();
  });

  it("releases the lease when an unexpected throw escapes", async () => {
    findUniqueMock.mockResolvedValue(baseRow({ metafieldsDone: true, tagsDone: true, codFeeDone: true }));
    // The terminal "done" update explodes (e.g. Neon drops mid-update).
    updateMock.mockRejectedValue(new Error("connection lost"));
    await expect(processDeliverySyncTask("task-1")).rejects.toThrow("connection lost");
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: "task-1" },
      data: { lockedAt: null },
    });
  });
});

describe("deliverySyncBackoffMs", () => {
  it("follows the sweep pacing schedule and clamps both ends", () => {
    expect(deliverySyncBackoffMs(1)).toBe(60_000);
    expect(deliverySyncBackoffMs(2)).toBe(5 * 60_000);
    expect(deliverySyncBackoffMs(7)).toBe(720 * 60_000);
    expect(deliverySyncBackoffMs(99)).toBe(720 * 60_000);
    expect(deliverySyncBackoffMs(0)).toBe(60_000);
  });
});

describe("getDeliverySyncIssues", () => {
  it("counts failed + stuck-pending rows and samples display names", async () => {
    countMock.mockResolvedValue(5);
    findManyMock.mockResolvedValue([
      { orderName: "#1046", shopifyOrderId: ORDER_GID },
      { orderName: null, shopifyOrderId: "gid://shopify/Order/222" },
    ]);
    const summary = await getDeliverySyncIssues(SHOP);
    expect(summary).toEqual({ count: 5, orderNames: ["#1046", "#222"] });
    const where = countMock.mock.calls[0][0].where;
    expect(where.shop).toBe(SHOP);
    expect(where.OR).toEqual([
      { status: "failed" },
      { status: "pending", attempts: { gte: 3 } },
    ]);
  });
});

describe("retryDeliverySyncIssues", () => {
  it("is a no-op when nothing is stuck", async () => {
    findManyMock.mockResolvedValue([]);
    expect(await retryDeliverySyncIssues(SHOP)).toEqual({ retried: 0 });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("re-arms every stuck row and enqueues a task each", async () => {
    findManyMock.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    expect(await retryDeliverySyncIssues(SHOP)).toEqual({ retried: 2 });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "t2"] } },
      data: expect.objectContaining({ status: "pending", attempts: 0, lockedAt: null }),
    });
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(findUniqueMock).not.toHaveBeenCalled(); // no inline processing needed
  });

  it("falls back to inline processing when no queue is configured (dev)", async () => {
    findManyMock.mockResolvedValue([{ id: "t1" }]);
    enqueueMock.mockResolvedValue({ ok: false, error: "nc", notConfigured: true });
    findUniqueMock.mockResolvedValue(null); // inline path runs; not_found is fine
    expect(await retryDeliverySyncIssues(SHOP)).toEqual({ retried: 1 });
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: "t1" } });
  });
});
