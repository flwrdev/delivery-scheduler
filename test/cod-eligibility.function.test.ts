import { describe, expect, it } from "vitest";

import {
  cartPaymentMethodsTransformRun,
  normalizeCity,
} from "../extensions/cod-eligibility/src/cart_payment_methods_transform_run";

const COD_ID = "gid://shopify/PaymentCustomizationPaymentMethod/1";
const XENDIT_ID = "gid://shopify/PaymentCustomizationPaymentMethod/2";

type Address = {
  countryCode?: string;
  provinceCode?: string;
  city?: string;
  zip?: string;
};

function buildInput({
  subtotal = "3000.0",
  address = {
    countryCode: "PH",
    provinceCode: "00",
    city: "Makati",
    zip: "1210",
  } as Address | null,
  config = null as Record<string, unknown> | null,
  paymentMethods = [
    { id: COD_ID, name: "Cash on Delivery (COD)" },
    { id: XENDIT_ID, name: "Xendit - Cards, Bank Transfers, QR, Ewallets" },
  ],
} = {}) {
  return {
    cart: {
      cost: { subtotalAmount: { amount: subtotal } },
      deliveryGroups: address ? [{ deliveryAddress: address }] : [],
    },
    paymentMethods,
    paymentCustomization: {
      metafield: config ? { jsonValue: config } : null,
    },
  } as Parameters<typeof cartPaymentMethodsTransformRun>[0];
}

const hidesCod = (result: { operations: unknown[] }) =>
  expect(result.operations).toEqual([
    { paymentMethodHide: { paymentMethodId: COD_ID } },
  ]);

const showsCod = (result: { operations: unknown[] }) =>
  expect(result.operations).toEqual([]);

describe("normalizeCity", () => {
  it("strips the city suffix and punctuation", () => {
    expect(normalizeCity("Quezon City")).toBe("quezon");
    expect(normalizeCity("City of Manila")).toBe("manila");
    expect(normalizeCity("TAGUIG")).toBe("taguig");
  });

  it("strips diacritics used in NCR city names", () => {
    expect(normalizeCity("Parañaque")).toBe("paranaque");
    expect(normalizeCity("Las Piñas City")).toBe("las pinas");
  });
});

describe("cartPaymentMethodsTransformRun", () => {
  it("shows COD for a Metro Manila ZIP at or above the minimum", () => {
    showsCod(cartPaymentMethodsTransformRun(buildInput()));
  });

  it("hides COD below the minimum purchase", () => {
    hidesCod(cartPaymentMethodsTransformRun(buildInput({ subtotal: "1499.0" })));
  });

  it("treats the ZIP as authoritative over the city text", () => {
    hidesCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          address: { countryCode: "PH", city: "Makati", zip: "4027" },
        }),
      ),
    );
  });

  it("falls back to normalized city aliases when the ZIP is missing", () => {
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          address: { countryCode: "PH", city: "Q.C.", zip: "" },
        }),
      ),
    );
  });

  it("hides COD when there is no delivery address yet", () => {
    hidesCod(cartPaymentMethodsTransformRun(buildInput({ address: null })));
  });

  it("hides COD outside the Philippines", () => {
    hidesCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          address: { countryCode: "SG", city: "Singapore", zip: "018956" },
        }),
      ),
    );
  });

  it("does nothing when no payment method matches the COD name", () => {
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          subtotal: "100.0",
          paymentMethods: [{ id: XENDIT_ID, name: "Xendit" }],
        }),
      ),
    );
  });

  it("hides COD above the configured maximum amount (cap)", () => {
    hidesCod(
      cartPaymentMethodsTransformRun(
        buildInput({ subtotal: "12000.0", config: { maximumAmount: 10000 } }),
      ),
    );
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({ subtotal: "9000.0", config: { maximumAmount: 10000 } }),
      ),
    );
    showsCod(cartPaymentMethodsTransformRun(buildInput({ subtotal: "12000.0" })));
  });

  it("honors metafield overrides for the minimum amount", () => {
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({ subtotal: "1000.0", config: { minimumAmount: 500 } }),
      ),
    );
    hidesCod(
      cartPaymentMethodsTransformRun(
        buildInput({ subtotal: "1000.0", config: { minimumAmount: 1500 } }),
      ),
    );
  });
});
