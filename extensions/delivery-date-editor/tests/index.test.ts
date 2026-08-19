/// <reference types="@shopify/ui-extensions/customer-account.order-status.block.render" />
// delivery-date-editor — the read-only Delivery Schedule block on the
// customer-account order-status page (docs/api.md §2: reads block state and
// calls read endpoints only).
//
// It merges three sources of truth, in this precedence order: the optimistic
// handoff the reschedule modal left in `shopify.storage`, the direct
// /public/customer-account/order-delivery read, then the host's own metafields
// and legacy checkout attributes. The precedence exists because closing the
// reschedule modal does not reliably make Shopify refetch the order.
import { getExtension } from "@shopify/ui-extensions-tester";
import { createStorage } from "@shopify/ui-extensions-tester/customer-account";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extension = getExtension("customer-account.order-status.block.render");

const ORDER_ID = "gid://shopify/Order/1";

function metafield(namespace: string, key: string, value: string) {
  return { target: { type: "order" as const }, metafield: { namespace, key, value } };
}

// The mock subscribables expose BOTH `value` and `current`, and the extension
// reads `current ?? value` — so an override has to set both to take effect.
function setSubscribable(subscribable: { value?: unknown; current?: unknown }, next: unknown) {
  subscribable.value = next;
  subscribable.current = next;
}

function texts() {
  return [...document.body.querySelectorAll("s-text")].map(
    (node) => node.textContent ?? "",
  );
}

beforeEach(() => {
  // The block installs a 1s polling interval it never clears. Faking only the
  // interval timers keeps it inert between tests without touching Date.now(),
  // which the pending-sync freshness window depends on.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  extension.setUp();
  // Quiet 200 with no `delivery` key: the direct read reports "nothing fresher
  // than what the host already gave us".
  extension.fetch = vi.fn(
    async () => new Response(JSON.stringify({})),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  extension.tearDown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("delivery-date-editor order-status block", () => {
  it("renders the delivery values from the custom.* metafields", async () => {
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    const section = document.body.querySelector("s-section");
    expect(section?.getAttribute("heading")).toBe("Delivery Schedule · #1000");
    expect(texts()).toEqual([
      "Date",
      "2026-09-02",
      "Time slot",
      "9AM-12PM",
    ]);
  });

  it("renders nothing when the order carries no delivery state at all", async () => {
    setSubscribable(extension.shopify.appMetafields, []);
    setSubscribable(extension.shopify.attributes, undefined);
    setSubscribable(extension.shopify.order, undefined);

    await extension.render();

    expect(document.body.querySelector("s-section")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("falls back to the legacy Delivery Date/Time attributes", async () => {
    setSubscribable(extension.shopify.appMetafields, []);
    setSubscribable(extension.shopify.attributes, [
      { key: "Delivery Date", value: "2026-09-05" },
      { key: "Delivery Time", value: "6PM-11PM" },
      { key: "Card Message", value: "Happy birthday" },
    ]);

    await extension.render();

    expect(texts()).toEqual([
      "Date",
      "2026-09-05",
      "Time slot",
      "6PM-11PM",
      "Card message",
      "Happy birthday",
    ]);
  });

  it("adds a Rescheduled badge when the reschedule status metafield is confirmed", async () => {
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
      metafield("$app", "reschedule_status", "confirmed"),
    ]);

    await extension.render();

    const badge = document.body.querySelector("s-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Rescheduled to ");
    // The badge spells the date out; the raw ISO stays out of the customer's view.
    expect(badge?.textContent).not.toContain("2026-09-02");
  });

  it("prefers the modal's pending-sync handoff over the stale host metafields", async () => {
    // What order-action-modal.tsx wrote right after a successful reschedule.
    extension.shopify.storage = createStorage({
      [`delivery-reschedule-sync:${ORDER_ID}`]: {
        date: "2026-09-09",
        timeSlot: "3PM-6PM",
        status: "confirmed",
        updatedAt: Date.now(),
      },
    });
    // The host payload still shows the PRE-reschedule values.
    setSubscribable(extension.shopify.appMetafields, [
      metafield("custom", "date", "2026-09-02"),
      metafield("custom", "time_slot", "9AM-12PM"),
    ]);

    await extension.render();

    expect(texts()).toEqual([
      "Date",
      "2026-09-09",
      "Time slot",
      "3PM-6PM",
    ]);
    // The handoff also carries the confirmed status, so the badge appears.
    expect(document.body.querySelector("s-badge")).not.toBeNull();
  });
});
