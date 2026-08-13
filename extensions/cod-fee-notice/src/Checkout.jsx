// "Total with fee" — the cash a COD customer actually hands the rider, on the
// Thank You page (purchase.thank-you.block.render).
//
//     ─────────────────────────────────────
//     COD FEE                      ₱70.00
//     Total with fee            ₱1,034.00
//
// Why this exists as its own extension:
//
// The +₱70 COD fee lands POST-purchase via order edit (orders/create webhook),
// so Shopify's own Total on this page is the PRE-EDIT checkout snapshot (₱964)
// while the line list already shows the "COD FEE ₱70.00" item — the panel's
// arithmetic visibly fails to add up. No thank-you target renders inside the
// cost breakdown and an extension can never edit a Shopify-rendered value
// (audited 2026-08-07; the shop is on the `Shopify` plan, so no checkout.liquid
// or Scripts either). A BLOCK target is the only kind the merchant can position
// himself, so this row can sit directly BELOW Shopify's Total — which is why it
// is a separate extension: `delivery-thank-you` already occupies
// purchase.thank-you.block.render, and a target may be registered only once per
// extension.
//
// Placement is a merchant step in the checkout editor (Settings → Checkout →
// Customize → Thank you page). This extension was previously the retired
// cod-fee-notice banner; the handle and uid are kept so an already-placed block
// keeps its position instead of needing to be re-added.
//
// The card in `delivery-thank-you` explains WHY the fee is there; this row only
// states the number, so the two never restate the same total twice.
//
// Both rows live in THIS block because it is the only surface that renders.
// `purchase.thank-you.cart-line-list.render-after` would have put the fee row
// in the item list, exactly where Shopify draws the real line — but a
// diagnostic build that rendered unconditionally produced nothing on a live
// COD order (dev-22, order #TA47AH0MC, 2026-08-14), so that static target does
// not run on this shop. Do not reach for it again without re-testing.
//
// COD detection and the fee amount come from ./cod-fee.js, a byte-identical
// copy of the one in delivery-thank-you/src (see that file's header).

import '@shopify/ui-extensions/preact';
import {render} from "preact";

import {
  codFeeLineIsVisible,
  isCashOnDeliveryOrder,
  resolveCodFee,
} from './cod-fee.js';

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

  // No readable total (or no fee to add) — render nothing rather than a row
  // with a wrong or missing amount.
  if (!Number.isFinite(orderTotal) || !(fee > 0)) {
    return null;
  }

  const currency = total.currencyCode ?? 'PHP';

  // The fee row names the ₱70 that turns Shopify's Total into the amount the
  // rider collects. It is skipped only when Shopify is ALREADY listing the real
  // "COD FEE" line item — that line is drawn from `order.lineItems` and no
  // extension can hide it, so repeating it would show ₱70 twice in one panel.
  // In practice the order edit lands 7-10s after this page renders, so the row
  // is what the customer usually sees.
  const showFeeRow = !codFeeLineIsVisible();

  return (
    <s-stack direction="block" gap="base">
      <s-divider />
      {/* `strong` (bold), not `emphasis` — emphasis renders italic, which read
          as a footnote next to Shopify's bold Total row. */}
      <s-grid gridTemplateColumns="1fr auto" gap="small-200">
        {showFeeRow ? <s-text>COD FEE</s-text> : null}
        {showFeeRow ? (
          <s-text>{shopify.i18n.formatCurrency(fee, {currency})}</s-text>
        ) : null}
        <s-text type="strong">Total with fee</s-text>
        <s-text type="strong">
          {shopify.i18n.formatCurrency(orderTotal + fee, {currency})}
        </s-text>
      </s-grid>
    </s-stack>
  );
}
