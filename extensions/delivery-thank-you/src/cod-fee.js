// Shared COD helpers for the Thank You page surfaces — the COD sentence on the
// Delivery Schedule card (extensions/delivery-thank-you) and the "Total with
// fee" row (extensions/cod-fee-notice) — so the two can never disagree on "is
// this COD?" or "how much is the fee?".
//
// DUPLICATED ON PURPOSE: Shopify bundles each extension folder separately, so a
// module living outside an extension's own directory is not reliably resolvable
// from it. The two copies must stay byte-identical; test/thank-you-cod-fee.test.ts
// runs its whole suite against BOTH, so an unmirrored edit fails the build.
//
// `shopify` is the per-target runtime global; every thank-you target exposes the
// Standard API surfaces these helpers touch.

const DEFAULT_COD_FEE = 70;

// COD detection: shopify.selectedPaymentOptions IS populated on the Thank You
// page (verified live 2026-07-28) and the merchant's manual COD method arrives
// as type "paymentOnDelivery" — NOT "manualPayment" (that type also covers
// bank deposit and friends, which carry no COD fee).
export function isCashOnDeliveryOrder() {
  const selectedOptions = shopify.selectedPaymentOptions?.value ?? [];
  return selectedOptions.some((option) => option.type === 'paymentOnDelivery');
}

// The fee amount, preferring live order data over the display setting.
//
// No usable live signal — the fee line hasn't landed, the page is an all-pre-edit
// snapshot, or the order carries a cart-level discount — falls back to the
// merchant setting, then to ₱70.
export function resolveCodFee() {
  const charged = feeFromLineGap();
  if (charged != null) {
    return charged;
  }

  const feeSetting = Number(shopify.settings?.value?.fee_amount);
  return Number.isFinite(feeSetting) && feeSetting > 0
    ? feeSetting
    : DEFAULT_COD_FEE;
}

// Whether Shopify is ALREADY listing the "COD FEE" line item. It draws that
// line from `order.lineItems` once the orders/create order edit lands — 7-10s
// after checkout on prod, while this page renders in 1-3s — so most customers
// see the list without it. Nothing in an extension can hide that line, so the
// stand-in row we draw in its place must disappear the moment it arrives.
//
// Deliberately ignores the discount guard below: a false "visible" costs one
// explanatory row, a false "not visible" shows ₱70 twice. Bias toward quiet.
export function codFeeLineIsVisible() {
  return lineGap() > 0.005;
}

// The orders/create webhook adds the COD Fee line AFTER checkout completes, so
// this page can already list that line while `cost` is still the pre-edit
// checkout snapshot. When that is the case, the gap between the line list and
// `cost.subtotalAmount` IS the fee — trust it, so a merchant who repriced the
// COD Fee product but forgot the `fee_amount` setting still sees the real
// number.
//
// Returns null when the gap can't be trusted, so the caller falls back.
function feeFromLineGap() {
  // A cart-level discount makes the comparison meaningless: Shopify documents
  // `cost.subtotalAmount` only as "the sum of all line item prices... before
  // shipping and taxes" — it does not say whether ORDER-level discounts are
  // already deducted. On a discounted order the gap could therefore be the
  // discount rather than the fee, and this number is the cash the customer
  // hands the rider. Use the merchant setting instead of guessing.
  const cartDiscounts = shopify.discountAllocations?.value ?? [];
  if (cartDiscounts.length > 0) {
    return null;
  }

  const gap = lineGap();
  return gap > 0.005 ? gap : null;
}

// How much the line list exceeds the snapshot subtotal — the fee, once its
// line has landed. 0 when either API is unavailable, so both callers above
// read that as "no fee line".
function lineGap() {
  const lines = shopify.lines?.value ?? [];
  const subtotal = Number(shopify.cost?.subtotalAmount?.value?.amount);
  if (lines.length === 0 || !Number.isFinite(subtotal)) {
    return 0;
  }

  const linesTotal = lines.reduce(
    (sum, line) => sum + Number(line.cost?.totalAmount?.amount ?? 0),
    0,
  );

  return linesTotal - subtotal;
}
