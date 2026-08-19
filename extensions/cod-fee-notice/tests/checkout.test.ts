/// <reference types="@shopify/ui-extensions/purchase.thank-you.block.render" />
// "Total with fee" row (cod-fee-notice) — render-level.
//
// This block is the only place a COD customer reads the cash to hand the rider:
// Shopify's own Total on the Thank You page is the PRE-EDIT checkout snapshot,
// so the row adds the fee back on. A regression here is a wrong number at the
// door, which is why the arithmetic is pinned at render level and not only in
// the helper unit suite (test/thank-you-cod-fee.test.ts).
//
// Note on amounts: the tester's `i18n.formatCurrency` mock stringifies the
// number and drops the currency, so the assertions below read "70" / "1034"
// rather than "₱70.00".
import { getExtension } from "@shopify/ui-extensions-tester";
import { createCartLine } from "@shopify/ui-extensions-tester/checkout";
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

beforeEach(() => {
  extension.setUp();
});

afterEach(() => {
  extension.tearDown();
});

function textsOf(selector: string) {
  return [...document.body.querySelectorAll(selector)].map(
    (node) => node.textContent ?? "",
  );
}

describe("cod-fee-notice thank-you block", () => {
  it("renders the fee row and Shopify's total plus the fee on a COD order", async () => {
    extension.shopify.selectedPaymentOptions.value = [COD_PAYMENT_OPTION];
    extension.shopify.cost.totalAmount.value = {
      amount: 964,
      currencyCode: "PHP",
    };
    // The `$app:cod`/`fee` shop metafield is the mirror /app/cod-settings
    // writes — the only link between the settings page and what the customer
    // reads (prod #4096, 2026-08-14).
    extension.shopify.appMetafields.value = [shopFeeMetafield(70)];

    await extension.render();

    const grid = document.body.querySelector("s-grid");
    expect(grid).not.toBeNull();

    // No fee line has landed yet (no cart lines), so the stand-in "COD FEE"
    // row is shown alongside the computed total.
    const texts = textsOf("s-grid s-text");
    expect(texts).toEqual(["COD FEE", "70", "Total with fee", "1034"]);
  });

  it("renders nothing when the order was not paid on delivery", async () => {
    extension.shopify.selectedPaymentOptions.value = [CARD_PAYMENT_OPTION];
    extension.shopify.cost.totalAmount.value = {
      amount: 964,
      currencyCode: "PHP",
    };

    await extension.render();

    expect(document.body.querySelector("s-grid")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("drops the stand-in fee row once Shopify is already listing the COD FEE line", async () => {
    // codFeeLineIsVisible(): no cart-level discount + the line list exceeding
    // the snapshot subtotal by the fee = the real "COD FEE" line item landed.
    extension.shopify.selectedPaymentOptions.value = [COD_PAYMENT_OPTION];
    extension.shopify.cost.subtotalAmount.value = {
      amount: 964,
      currencyCode: "PHP",
    };
    extension.shopify.cost.totalAmount.value = {
      amount: 964,
      currencyCode: "PHP",
    };
    extension.shopify.lines.value = [
      createCartLine({
        cost: { totalAmount: { amount: 1034, currencyCode: "PHP" } },
      }),
    ];

    await extension.render();

    // Only the total pair survives — repeating the fee would show it twice in
    // one panel, next to a line Shopify draws and no extension can hide.
    const texts = textsOf("s-grid s-text");
    expect(texts).toEqual(["Total with fee", "1034"]);
    expect(document.body.textContent).not.toContain("COD FEE");
  });
});
