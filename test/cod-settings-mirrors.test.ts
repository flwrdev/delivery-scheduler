// The COD fee is mirrored to Releasit's own `_cod_fee.commission` metafield so
// the order confirmation email states the amount the customer actually owes.
//
// Releasit's Liquid does the arithmetic itself — at send time the order is
// still pre-edit, so it adds `commission` to the total it sees. That is why the
// UNIT matters: it stores centavos, and a value written in pesos would render
// as ₱70.00 → "₱70" worth of centavos, i.e. 70 centavos, silently turning the
// customer's "Total Amount Due" into the pre-fee total.

import { describe, expect, it } from "vitest";

import {
  COD_FEE_LIQUID_KEY,
  COD_FEE_LIQUID_NAMESPACE,
  COD_FEE_METAFIELD_KEY,
  COD_FEE_METAFIELD_NAMESPACE,
  RELEASIT_FEE_KEY,
  RELEASIT_FEE_NAMESPACE,
  toReleasitCentavos,
} from "../app/lib/cod-fee-mirrors";

describe("toReleasitCentavos", () => {
  // ₱70 is the live value; Releasit had exactly "7000" on prod before this.
  it("converts pesos to centavos", () => {
    expect(toReleasitCentavos(70)).toBe("7000");
    expect(toReleasitCentavos(85)).toBe("8500");
  });

  // The metafield is number_integer — a fractional string is rejected outright,
  // which would only surface as a console.warn and a stale email.
  it("always yields an integer string", () => {
    expect(toReleasitCentavos(72.5)).toBe("7250");
    expect(toReleasitCentavos(70.999)).toBe("7100");
    expect(toReleasitCentavos(0.1)).toBe("10");
  });

  // Float noise: 8.15 * 100 is 814.9999… in IEEE 754, so truncating would write
  // 814 and quietly shave a centavo off every COD order. Rounding absorbs it.
  it("rounds instead of truncating binary float error", () => {
    expect(toReleasitCentavos(8.15)).toBe("815");
    expect(toReleasitCentavos(70.07)).toBe("7007");
  });

  // Honest limit: a THIRD decimal sitting exactly on a half-centavo can land
  // either way, because 1.005 * 100 is 100.4999… before rounding. Not a defect
  // to fix — the settings field is a peso amount and every 2-decimal input is
  // exact, which is the only range this is contracted for.
  it("is exact for every 2-decimal peso amount", () => {
    for (let cents = 0; cents <= 20000; cents += 1) {
      const pesos = cents / 100;
      expect(toReleasitCentavos(pesos)).toBe(String(cents));
    }
  });
});

// Each surface reads a different namespace and none can read another's; the
// names are the contract, so a rename here silently breaks a live display.
describe("mirror namespaces", () => {
  it("keeps the three targets distinct and correctly named", () => {
    expect([COD_FEE_METAFIELD_NAMESPACE, COD_FEE_METAFIELD_KEY]).toEqual([
      "$app:cod",
      "fee",
    ]);
    expect([COD_FEE_LIQUID_NAMESPACE, COD_FEE_LIQUID_KEY]).toEqual([
      "custom",
      "cod_fee",
    ]);
    expect([RELEASIT_FEE_NAMESPACE, RELEASIT_FEE_KEY]).toEqual([
      "_cod_fee",
      "commission",
    ]);
  });

  // Liquid cannot resolve an app-reserved namespace — that is the entire reason
  // the `custom` copy exists alongside the `$app:cod` one.
  it("keeps the Liquid copy out of the app-reserved namespace", () => {
    expect(COD_FEE_LIQUID_NAMESPACE.startsWith("$app")).toBe(false);
  });
});
