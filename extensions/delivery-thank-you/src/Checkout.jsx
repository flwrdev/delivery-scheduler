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
// COD detection: shopify.selectedPaymentOptions IS populated on the Thank You
// page (verified live 2026-07-28) and manual COD arrives with type
// "paymentOnDelivery" — NOT "manualPayment" (that type covers other manual
// methods like bank deposit, which carry no COD fee). The +₱70 fee lands
// POST-purchase via order edit (orders/create webhook), so Thank-You totals
// never include it — the card shows the real amount to hand the rider.

import '@shopify/ui-extensions/preact';
import {render} from "preact";

const DEFAULT_COD_FEE = 70;

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
              A {cod.feeFormatted} COD fee has been added to your order.
            </s-text>
            {cod.totalFormatted ? (
              <s-text type="emphasis">
                Total to pay on delivery: {cod.totalFormatted}
              </s-text>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>
    </s-box>
  );
}

function getCodNotice() {
  const selectedOptions = shopify.selectedPaymentOptions?.value ?? [];
  const isCashOnDelivery = selectedOptions.some(
    (option) => option.type === 'paymentOnDelivery',
  );
  if (!isCashOnDelivery) {
    return null;
  }

  const feeSetting = Number(shopify.settings.value?.fee_amount);
  const fee =
    Number.isFinite(feeSetting) && feeSetting > 0
      ? feeSetting
      : DEFAULT_COD_FEE;

  const total = shopify.cost.totalAmount.value;
  const currency = total?.currencyCode ?? 'PHP';
  const totalWithFee = total ? Number(total.amount) + fee : null;

  return {
    feeFormatted: shopify.i18n.formatCurrency(fee, {currency}),
    totalFormatted:
      totalWithFee != null
        ? shopify.i18n.formatCurrency(totalWithFee, {currency})
        : null,
  };
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
