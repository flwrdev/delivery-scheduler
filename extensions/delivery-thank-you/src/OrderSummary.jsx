// ⚠️ NOT REGISTERED — this file is kept as reference only and does not run.
//
// It was the first attempt at showing the COD totals, from the static target
// purchase.thank-you.cart-line-list.render-after, which renders ABOVE Shopify's
// Subtotal row. The merchant wants the computed amount BELOW Shopify's Total,
// which only a merchant-positioned BLOCK target can do — so the shipping
// version is the one-row "Total with fee" in extensions/cod-fee-notice, and
// this target was removed from shopify.extension.toml on 2026-08-13.
//
// Restore it only if the block ever proves unplaceable inside the summary
// panel; the fee resolution it uses lives on in ./cod-fee.js.
//
// ---------------------------------------------------------------------------
//
// COD totals rows INSIDE the Thank You order summary panel
// (purchase.thank-you.cart-line-list.render-after — the ONLY static extension
// slot inside that panel; it renders below the line items and directly ABOVE
// Shopify's own Subtotal / Shipping / Total block).
//
// Shopify's own totals on this page cannot be changed by an extension, and
// they are the pre-edit CHECKOUT snapshot: the +₱70 fee lands POST-purchase
// via order edit (orders/create webhook), and no thank-you target renders
// inside the cost breakdown (API 2026-04 exposes eight thank-you targets, none
// of them a totals target). So this block states the arithmetic instead:
//
//     Order total                 ₱964.00   ← the SAME number Shopify shows below
//     Cash on Delivery fee       + ₱70.00
//     ─────────────────────────────────────
//     Total to pay on delivery  ₱1,034.00
//
// Showing Shopify's ₱964 as an OPERAND is deliberate. The line list already
// carries the "COD FEE ₱70.00" item while Shopify's Subtotal still says ₱799,
// so the panel's arithmetic visibly fails to add up; naming ₱964 explains the
// number underneath rather than contradicting it.
//
// COD detection and the fee amount come from ./cod-fee.js, shared with the
// block card in src/Checkout.jsx so the two can never disagree.

import '@shopify/ui-extensions/preact';
import {render} from "preact";

import {isCashOnDeliveryOrder, resolveCodFee} from './cod-fee.js';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  if (!isCashOnDeliveryOrder()) {
    return null;
  }

  const total = shopify.cost?.totalAmount?.value;
  const orderTotal = Number(total?.amount);
  const fee = resolveCodFee();
  if (!Number.isFinite(orderTotal) || !(fee > 0)) {
    return null;
  }

  const currency = total.currencyCode ?? 'PHP';
  const format = (amount) => shopify.i18n.formatCurrency(amount, {currency});

  return (
    <s-stack direction="block" gap="small-200">
      <s-divider />
      <s-grid gridTemplateColumns="1fr auto" gap="small-200">
        <s-text>Order total</s-text>
        <s-text>{format(orderTotal)}</s-text>
        <s-text>Cash on Delivery fee</s-text>
        <s-text>+ {format(fee)}</s-text>
      </s-grid>
      <s-divider />
      <s-grid gridTemplateColumns="1fr auto" gap="small-200">
        <s-text type="emphasis">Total to pay on delivery</s-text>
        <s-text type="emphasis">{format(orderTotal + fee)}</s-text>
      </s-grid>
    </s-stack>
  );
}
