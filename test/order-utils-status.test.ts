import { describe, it, expect } from "vitest";
import {
  type Order,
  isCancelled,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  getDeliveryStatus,
} from "../app/lib/order-utils";

// S11: cancelled orders keep displayFulfillmentStatus === "UNFULFILLED", so
// every status surface must consult cancelledAt before the raw status.

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-07-08T00:00:00Z",
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    displayFinancialStatus: "PAID",
    tags: [],
    customer: null,
    deliveryDate: null,
    deliveryTimeSlot: null,
    customDate: null,
    customTimeSlot: null,
    rescheduleHistory: null,
    ...overrides,
  }) as Order;

describe("isCancelled", () => {
  it("is false without cancelledAt and true with it", () => {
    expect(isCancelled(order())).toBe(false);
    expect(isCancelled(order({ cancelledAt: "2026-07-12T00:00:00Z" }))).toBe(
      true,
    );
  });
});

describe("fulfillmentBadge", () => {
  it("renders the formatted fulfillment status for a live order", () => {
    expect(fulfillmentBadge(order())).toEqual({
      label: "Unfulfilled",
      tone: "caution",
    });
  });

  it("overrides with a critical Cancelled badge for a cancelled order", () => {
    expect(
      fulfillmentBadge(order({ cancelledAt: "2026-07-12T00:00:00Z" })),
    ).toEqual({ label: "Cancelled", tone: "critical" });
  });
});

describe("isOpenDeliverableOrder", () => {
  it("treats an unfulfilled, uncancelled order as open", () => {
    expect(isOpenDeliverableOrder(order())).toBe(true);
  });

  it("closes the order when cancelled — no Today/Overdue chips", () => {
    expect(
      isOpenDeliverableOrder(order({ cancelledAt: "2026-07-12T00:00:00Z" })),
    ).toBe(false);
  });

  it("closes the order when fulfilled", () => {
    expect(
      isOpenDeliverableOrder(order({ displayFulfillmentStatus: "FULFILLED" })),
    ).toBe(false);
  });
});

describe("getDeliveryStatus", () => {
  it("puts Cancelled ahead of every other derived status", () => {
    const cancelled = order({
      cancelledAt: "2026-07-12T00:00:00Z",
      displayFulfillmentStatus: "FULFILLED",
      deliveryDate: { value: "2026-07-18" },
    });
    expect(getDeliveryStatus(cancelled)).toEqual({
      label: "Cancelled",
      tone: "critical",
    });
  });

  it("still derives Scheduled for a dated live order", () => {
    expect(
      getDeliveryStatus(order({ deliveryDate: { value: "2026-07-18" } })),
    ).toEqual({ label: "Scheduled", tone: "success" });
  });
});
