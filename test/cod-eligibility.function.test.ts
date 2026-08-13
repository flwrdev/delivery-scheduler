import { describe, expect, it } from "vitest";

import {
  cartPaymentMethodsTransformRun,
  normalizeCity,
  withFeeSuffix,
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

// Settings → Payments has no API, so the "+₱70" the merchant typed into the COD
// method name cannot follow /app/cod-settings on its own. Renaming the method
// at checkout is the only way — otherwise a fee raised to ₱85 leaves the
// customer picking an option that still promises ₱70.
describe("withFeeSuffix", () => {
  it("replaces an existing fee suffix instead of stacking one", () => {
    expect(withFeeSuffix("Cash on Delivery (COD) +₱70", 85)).toBe(
      "Cash on Delivery (COD) +₱85",
    );
    expect(withFeeSuffix("Cash on Delivery (COD) + P70.00", 85)).toBe(
      "Cash on Delivery (COD) +₱85",
    );
    expect(withFeeSuffix("Cash on Delivery (COD) +1,070", 85)).toBe(
      "Cash on Delivery (COD) +₱85",
    );
  });

  it("appends to a name that has no fee yet", () => {
    expect(withFeeSuffix("Cash on Delivery", 70)).toBe("Cash on Delivery +₱70");
  });

  // "70" reads like the merchant's own label; "70.00" only when it must.
  it("drops the decimals on a whole amount", () => {
    expect(withFeeSuffix("COD", 70)).toBe("COD +₱70");
    expect(withFeeSuffix("COD", 72.5)).toBe("COD +₱72.50");
  });

  // The name ends in a number that is NOT a fee — a trailing "(COD)" is safe,
  // but a bare number would be eaten. Only a `+`-prefixed one is stripped.
  it("leaves a trailing number alone unless it follows a plus", () => {
    expect(withFeeSuffix("Cash on Delivery 2", 70)).toBe(
      "Cash on Delivery 2 +₱70",
    );
  });
});

describe("cartPaymentMethodsTransformRun fee rename", () => {
  const renames = (result: { operations: unknown[] }, name: string) =>
    expect(result.operations).toEqual([
      { paymentMethodRename: { paymentMethodId: COD_ID, name } },
    ]);

  it("renames the COD method to the fee the app currently charges", () => {
    renames(
      cartPaymentMethodsTransformRun(
        buildInput({
          config: { feeAmount: 85 },
          paymentMethods: [
            { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
            { id: XENDIT_ID, name: "Xendit" },
          ],
        }),
      ),
      "Cash on Delivery (COD) +₱85",
    );
  });

  // A shop that never saved the settings page keeps the merchant's own label.
  it("leaves the name alone when no fee is configured", () => {
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          paymentMethods: [
            { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
            { id: XENDIT_ID, name: "Xendit" },
          ],
        }),
      ),
    );
  });

  it("emits nothing when the name already reads correctly", () => {
    showsCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          config: { feeAmount: 70 },
          paymentMethods: [
            { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
            { id: XENDIT_ID, name: "Xendit" },
          ],
        }),
      ),
    );
  });

  it("ignores a zero or negative configured fee", () => {
    for (const feeAmount of [0, -5]) {
      showsCod(
        cartPaymentMethodsTransformRun(
          buildInput({
            config: { feeAmount },
            paymentMethods: [
              { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
              { id: XENDIT_ID, name: "Xendit" },
            ],
          }),
        ),
      );
    }
  });

  // Hiding wins over renaming — an ineligible cart must not be offered COD at
  // all, however its label reads.
  it("still hides COD outside Metro Manila even with a fee configured", () => {
    hidesCod(
      cartPaymentMethodsTransformRun(
        buildInput({
          config: { feeAmount: 85 },
          address: { countryCode: "PH", city: "Cebu", zip: "6000" },
          paymentMethods: [
            { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
            { id: XENDIT_ID, name: "Xendit" },
          ],
        }),
      ),
    );
  });

  // The city-text fallback path returns a different object than the ZIP path.
  it("renames on the city fallback path too", () => {
    renames(
      cartPaymentMethodsTransformRun(
        buildInput({
          config: { feeAmount: 85 },
          address: { countryCode: "PH", city: "Quezon City" },
          paymentMethods: [
            { id: COD_ID, name: "Cash on Delivery (COD) +₱70" },
            { id: XENDIT_ID, name: "Xendit" },
          ],
        }),
      ),
      "Cash on Delivery (COD) +₱85",
    );
  });
});
