// Thank You page COD helpers (`src/cod-fee.js`).
//
// These back BOTH thank-you surfaces — the Delivery Schedule card's COD
// sentence and the "Total with fee" row the customer reads to know what cash to
// hand the rider — so a regression here shows a wrong amount at the door.
//
// The module is DUPLICATED into each extension folder (Shopify bundles every
// extension separately, so neither can import out of the other's directory).
// This suite therefore runs against BOTH copies and pins them byte-identical:
// an edit applied to only one fails here.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

// Plain-JS extension modules; resolved via the config's `allowJs`.
import * as scheduleCardCopy from "../extensions/delivery-thank-you/src/cod-fee.js";
import * as totalWithFeeCopy from "../extensions/cod-fee-notice/src/cod-fee.js";

const COPIES = [
  {
    name: "delivery-thank-you",
    mod: scheduleCardCopy,
    path: "../extensions/delivery-thank-you/src/cod-fee.js",
  },
  {
    name: "cod-fee-notice",
    mod: totalWithFeeCopy,
    path: "../extensions/cod-fee-notice/src/cod-fee.js",
  },
];

type StubLine = { cost?: { totalAmount?: { amount: number } } };

function setShopify(stub: {
  paymentOptions?: Array<{ type: string }>;
  lines?: StubLine[];
  subtotal?: number;
  feeSetting?: unknown;
  cartDiscounts?: unknown[];
}) {
  (globalThis as Record<string, unknown>).shopify = {
    selectedPaymentOptions:
      stub.paymentOptions === undefined
        ? undefined
        : { value: stub.paymentOptions },
    lines: stub.lines === undefined ? undefined : { value: stub.lines },
    cost: {
      subtotalAmount:
        stub.subtotal === undefined
          ? undefined
          : { value: { amount: stub.subtotal, currencyCode: "PHP" } },
    },
    discountAllocations: { value: stub.cartDiscounts ?? [] },
    settings: { value: { fee_amount: stub.feeSetting } },
  };
}

const line = (amount: number): StubLine => ({ cost: { totalAmount: { amount } } });

afterEach(() => {
  delete (globalThis as Record<string, unknown>).shopify;
});

// The duplication is only safe while the copies agree. Compare content with
// line endings normalised — git may check the two files out with different EOLs
// on Windows, which is not a drift worth failing on.
it("keeps the two cod-fee.js copies byte-identical", () => {
  const [first, second] = COPIES.map(({ path }) =>
    readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n"),
  );

  expect(first).toBe(second);
});

describe.each(COPIES)("cod-fee.js in $name", ({ mod }) => {
  const { isCashOnDeliveryOrder, resolveCodFee } = mod;

  describe("isCashOnDeliveryOrder", () => {
    it("matches the manual COD method's paymentOnDelivery type", () => {
      setShopify({ paymentOptions: [{ type: "paymentOnDelivery" }] });
      expect(isCashOnDeliveryOrder()).toBe(true);
    });

    // "manualPayment" also covers bank deposit and friends, which carry no fee —
    // the original cod-fee-notice bug (fixed 2026-07-28) was matching that type.
    it("does NOT match other manual payment methods", () => {
      setShopify({ paymentOptions: [{ type: "manualPayment" }] });
      expect(isCashOnDeliveryOrder()).toBe(false);
    });

    it("is false for card orders and when the API is absent", () => {
      setShopify({ paymentOptions: [{ type: "creditCard" }] });
      expect(isCashOnDeliveryOrder()).toBe(false);

      setShopify({});
      expect(isCashOnDeliveryOrder()).toBe(false);
    });
  });

  describe("resolveCodFee", () => {
    // The live case from the screenshot: the orders/create order edit has landed,
    // so the line list already carries COD FEE ₱70 while `cost` is still the
    // pre-edit checkout snapshot (subtotal ₱799). The gap IS the fee.
    it("reads the fee from the gap between the line list and the snapshot subtotal", () => {
      setShopify({
        lines: [line(799), line(70)],
        subtotal: 799,
        feeSetting: 70,
      });
      expect(resolveCodFee()).toBeCloseTo(70, 5);
    });

    // Why the gap wins over the setting: /app/cod-settings reprices the COD Fee
    // VARIANT, and the extension's `fee_amount` is a separate display-only knob
    // the merchant can forget. The charged amount must be the displayed amount.
    it("prefers the real charged amount over a stale fee_amount setting", () => {
      setShopify({
        lines: [line(799), line(100)],
        subtotal: 799,
        feeSetting: 70,
      });
      expect(resolveCodFee()).toBeCloseTo(100, 5);
    });

    // Shopify doesn't document whether `cost.subtotalAmount` is stated before or
    // after ORDER-level discounts, so on a discounted order the gap could be the
    // discount rather than the fee. Never guess with the rider's cash.
    it("ignores the gap entirely when the cart carries an order-level discount", () => {
      setShopify({
        lines: [line(799), line(70)],
        subtotal: 799,
        feeSetting: 85,
        cartDiscounts: [{ discountedAmount: { amount: 70, currencyCode: "PHP" } }],
      });
      expect(resolveCodFee()).toBe(85);

      setShopify({
        lines: [line(799), line(70)],
        subtotal: 799,
        cartDiscounts: [{ discountedAmount: { amount: 70, currencyCode: "PHP" } }],
      });
      expect(resolveCodFee()).toBe(70);
    });

    it("falls back to the merchant setting when the fee line has not landed yet", () => {
      setShopify({ lines: [line(799)], subtotal: 799, feeSetting: 85 });
      expect(resolveCodFee()).toBe(85);
    });

    it("falls back to ₱70 when the setting is blank, zero, or non-numeric", () => {
      for (const feeSetting of [undefined, "", 0, -5, "abc"]) {
        setShopify({ lines: [line(799)], subtotal: 799, feeSetting });
        expect(resolveCodFee()).toBe(70);
      }
    });

    // A subtotal that already covers the whole line list means the fee is either
    // absent or already counted — never invent one from a zero/negative gap.
    it("ignores a zero or negative gap", () => {
      setShopify({ lines: [line(799), line(70)], subtotal: 869, feeSetting: 42 });
      expect(resolveCodFee()).toBe(42);

      setShopify({ lines: [line(799)], subtotal: 900, feeSetting: 42 });
      expect(resolveCodFee()).toBe(42);
    });

    it("survives missing lines / cost APIs without throwing", () => {
      setShopify({ feeSetting: 70 });
      expect(resolveCodFee()).toBe(70);

      setShopify({ lines: [], subtotal: 799, feeSetting: 70 });
      expect(resolveCodFee()).toBe(70);
    });
  });

});
