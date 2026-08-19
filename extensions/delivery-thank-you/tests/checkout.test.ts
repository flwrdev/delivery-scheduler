/// <reference types="@shopify/ui-extensions/purchase.thank-you.block.render" />
// Delivery Schedule card (delivery-thank-you) — render-level.
//
// One Thank You card that carries two independent sections: the delivery
// date/slot the customer picked at checkout, and a sentence explaining the
// unexpected "COD FEE" line item. Either can be absent, and when BOTH are the
// component must render nothing at all rather than an empty bordered box.
//
// The card deliberately does NOT restate the total — that is cod-fee-notice's
// row (see docs/api.md, extensions table). These tests pin that split.
//
// Note on amounts: the tester's `i18n.formatCurrency` mock stringifies the
// number and drops the currency, so the fee reads as "85", not "₱85.00".
import { getExtension } from "@shopify/ui-extensions-tester";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const extension = getExtension("purchase.thank-you.block.render");

const COD_PAYMENT_OPTION = {
  type: "paymentOnDelivery" as const,
  handle: "cash-on-delivery",
};
const CARD_PAYMENT_OPTION = {
  type: "creditCard" as const,
  handle: "credit-card",
};

function cartMetafield(key: string, value: string) {
  return {
    target: { type: "cart" as const, id: "gid://shopify/Cart/1" },
    metafield: {
      namespace: "custom",
      key,
      value,
      valueType: "string" as const,
      type: "single_line_text_field",
    },
  };
}

function shopFeeMetafield(amount: number) {
  return {
    target: { type: "shop" as const, id: "gid://shopify/Shop/1" },
    metafield: {
      namespace: "$app:cod",
      key: "fee",
      value: String(amount),
      valueType: "string" as const,
      type: "single_line_text_field",
    },
  };
}

function headings() {
  return [...document.body.querySelectorAll("s-heading")].map(
    (node) => node.textContent ?? "",
  );
}

beforeEach(() => {
  extension.setUp();
});

afterEach(() => {
  extension.tearDown();
});

describe("delivery-thank-you card", () => {
  it("renders the schedule from the cart metafields, with the date formatted", async () => {
    extension.shopify.appMetafields.value = [
      cartMetafield("date", "2026-09-02"),
      cartMetafield("time_slot", "9AM-12PM"),
    ];

    await extension.render();

    expect(headings()).toEqual(["Delivery Schedule"]);

    const body = document.body.textContent ?? "";
    const formatted = new Date(2026, 8, 2).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(body).toContain(`Date: ${formatted}`);
    // The raw ISO value never reaches the customer.
    expect(body).not.toContain("2026-09-02");
    expect(body).toContain("Time slot: 9AM-12PM");
  });

  it("falls back to the legacy checkout attributes when no cart metafields exist", async () => {
    // Older orders never received the metafields; the attributes are the backup.
    extension.shopify.attributes.value = [
      { key: "Delivery Date", value: "2026-09-04" },
      { key: "Delivery Time", value: "3PM-6PM" },
    ];

    await extension.render();

    expect(headings()).toEqual(["Delivery Schedule"]);
    expect(document.body.textContent).toContain("Time slot: 3PM-6PM");
  });

  it("renders nothing when there is no schedule and the order is not COD", async () => {
    await extension.render();

    expect(document.body.querySelector("s-box")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("explains the COD fee using the amount /app/cod-settings mirrored onto the shop metafield", async () => {
    extension.shopify.selectedPaymentOptions.value = [COD_PAYMENT_OPTION];
    extension.shopify.appMetafields.value = [shopFeeMetafield(85)];

    await extension.render();

    expect(headings()).toEqual(["Cash on Delivery"]);
    expect(document.body.textContent).toContain(
      "A 85 COD fee has been added to your order.",
    );
  });

  it("omits the COD section on a non-COD order that has a schedule", async () => {
    extension.shopify.selectedPaymentOptions.value = [CARD_PAYMENT_OPTION];
    extension.shopify.appMetafields.value = [
      cartMetafield("date", "2026-09-02"),
      cartMetafield("time_slot", "9AM-12PM"),
      // Present but irrelevant — a fee mirror must not by itself draw the section.
      shopFeeMetafield(70),
    ];

    await extension.render();

    expect(headings()).toEqual(["Delivery Schedule"]);
    expect(document.body.textContent).not.toContain("COD fee");
    expect(document.body.querySelector("s-divider")).toBeNull();
  });
});
