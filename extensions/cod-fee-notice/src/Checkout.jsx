// COD fee notice — Thank You page block (purchase.thank-you.block.render).
//
// The +₱70 COD fee lands POST-purchase via order edit (orders/create webhook,
// services/cod-fee.server.ts), so the checkout/Thank-You totals never include
// it. This block closes that gap: when the buyer paid via the merchant's
// manual "Cash on Delivery" method, it shows the fee and the real amount to
// hand the rider — no surprise fee on the final invoice.
//
// COD detection: shopify.selectedPaymentOptions IS populated on the Thank You
// page (verified live 2026-07-28) and manual COD arrives with type
// "paymentOnDelivery" — NOT "manualPayment" (that type covers other manual
// methods like bank deposit, which carry no COD fee).
//
// Deliberately NOT rendered on the Order Status page: by the time the buyer
// opens it the order edit has landed and the order total already includes the
// fee — adding ₱70 again there would double-count it.

import '@shopify/ui-extensions/preact';
import {render} from 'preact';

const DEFAULT_FEE = 70;

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const selectedOptions = shopify.selectedPaymentOptions?.value ?? [];
  const isCashOnDelivery = selectedOptions.some(
    (option) => option.type === 'paymentOnDelivery',
  );
  if (!isCashOnDelivery) {
    return null;
  }

  const feeSetting = Number(shopify.settings.value?.fee_amount);
  const fee =
    Number.isFinite(feeSetting) && feeSetting > 0 ? feeSetting : DEFAULT_FEE;

  const total = shopify.cost.totalAmount.value;
  const currency = total?.currencyCode ?? 'PHP';
  const totalWithFee = total ? Number(total.amount) + fee : null;

  return (
    <s-banner heading={shopify.i18n.translate('heading')} tone="info">
      <s-stack gap="small-200">
        <s-text>
          {shopify.i18n.translate('feeLine', {
            fee: shopify.i18n.formatCurrency(fee, {currency}),
          })}
        </s-text>
        {totalWithFee != null && (
          <s-text type="emphasis">
            {shopify.i18n.translate('totalLine', {
              total: shopify.i18n.formatCurrency(totalWithFee, {currency}),
            })}
          </s-text>
        )}
      </s-stack>
    </s-banner>
  );
}
