// Delivery Schedule + COD fee notice — ONE Thank You page card
// (purchase.thank-you.block.render).
//
// Merged 2026-07-31: the COD fee notice used to be its own block
// (extensions/cod-fee-notice) rendered as a separate inset banner, which sat
// on a different left gutter than this block's plain section. Both now render
// inside one bordered card so the Thank You page reads as a single clean
// "Delivery Schedule" unit; cod-fee-notice renders nothing and can be removed
// from the checkout editor.
//
// The +₱70 fee lands POST-purchase via order edit (orders/create webhook), so
// Shopify's own Thank-You order summary never includes it. The COMPUTED total
// (Shopify's Total + fee = "Total with fee") is a SEPARATE extension —
// extensions/cod-fee-notice — whose block the merchant positions directly below
// Shopify's Total. This card only EXPLAINS the unexpected "COD FEE" line item;
// it must not restate the total, or the page would carry the same number twice.
//
// COD detection and the fee amount come from ./cod-fee.js, a byte-identical
// copy of the one in cod-fee-notice/src, so the two surfaces can never disagree.

import '@shopify/ui-extensions/preact';
import {render} from "preact";

import {isCashOnDeliveryOrder, resolveCodFee} from './cod-fee.js';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const appMetafields = shopify.appMetafields.value ?? [];
  const attributes = shopify.attributes.value ?? [];

  // Thank You extensions can read cart metafields directly; legacy checkout
  // attributes are only a backup for older orders that never received them.
  const deliveryDate =
    getCartMetafieldValue(appMetafields, 'custom', 'date') ??
    getAttributeValue(attributes, 'Delivery Date');
  const deliveryTime =
    getCartMetafieldValue(appMetafields, 'custom', 'time_slot') ??
    getAttributeValue(attributes, 'Delivery Time');
  const hasSchedule = Boolean(deliveryDate || deliveryTime);

  const cod = getCodNotice();

  if (!hasSchedule && !cod) {
    return null;
  }

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        {hasSchedule ? (
          <s-stack direction="block" gap="small-200">
            <s-heading>Delivery Schedule</s-heading>
            {deliveryDate ? (
              <s-text>Date: {formatDisplayDate(deliveryDate)}</s-text>
            ) : null}
            {deliveryTime ? <s-text>Time slot: {deliveryTime}</s-text> : null}
          </s-stack>
        ) : null}
        {hasSchedule && cod ? <s-divider /> : null}
        {cod ? (
          <s-stack direction="block" gap="small-200">
            <s-heading>Cash on Delivery</s-heading>
            <s-text>
              A {cod.feeFormatted} COD fee has been added to your order. See the
              order summary for the total to pay on delivery.
            </s-text>
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function getCodNotice() {
  if (!isCashOnDeliveryOrder()) {
    return null;
  }

  const fee = resolveCodFee();
  if (!(fee > 0)) {
    return null;
  }

  const currency = shopify.cost?.totalAmount?.value?.currencyCode ?? 'PHP';

  return {feeFormatted: shopify.i18n.formatCurrency(fee, {currency})};
}

function getCartMetafieldValue(appMetafields, namespace, key) {
  const entry = appMetafields.find(
    (appMetafield) =>
      appMetafield.target?.type === 'cart' &&
      appMetafield.metafield.namespace === namespace &&
      appMetafield.metafield.key === key,
  );

  return entry?.metafield?.value?.toString() ?? null;
}

function getAttributeValue(attributes, key) {
  const attribute = attributes.find((entry) => entry.key === key);
  return attribute?.value ?? null;
}

function formatDisplayDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate;
  }

  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
