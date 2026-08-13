// "COD FEE ₱70.00" — a stand-in for the real line item, rendered in its exact
// place on the Thank You page (purchase.thank-you.cart-line-list.render-after,
// a static target that draws directly after the last line item and above
// Shopify's Subtotal row).
//
//     HBD Balloon                 ₱100.00
//     COD FEE                      ₱70.00   ← this file
//     Subtotal                    ₱100.00
//     Shipping                     ₱98.00
//
// Why a stand-in is needed: the real "COD FEE" line is added to the order by
// the orders/create webhook, which lands 7-10s after checkout on prod — while
// this page renders in 1-3s. Most customers therefore never see it, and the
// jump from Total to "Total with fee" is left unexplained.
//
// Why it must yield: an extension can only ADD rows. Shopify draws the real
// line from `order.lineItems` and nothing here can hide it, so once it appears
// this row removes itself rather than showing ₱70 twice. `shopify.lines` is a
// signal read during render, so that swap happens on its own — no refresh.

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
  if (!isCashOnDeliveryOrder() || codFeeLineIsVisible()) {
    return null;
  }

  const fee = resolveCodFee();
  if (!(fee > 0)) {
    return null;
  }

  const currency =
    shopify.cost?.totalAmount?.value?.currencyCode ?? 'PHP';

  return (
    <s-grid gridTemplateColumns="1fr auto" gap="small-200">
      <s-text>COD FEE</s-text>
      <s-text>{shopify.i18n.formatCurrency(fee, {currency})}</s-text>
    </s-grid>
  );
}
