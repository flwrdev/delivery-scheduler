import '@shopify/ui-extensions/preact';
import {render} from "preact";

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

  if (!deliveryDate && !deliveryTime) {
    return null;
  }

  return (
    <s-section heading="Delivery Schedule">
      <s-stack direction="block" gap="base">
        {deliveryDate ? (
          <s-text>Date: {formatDisplayDate(deliveryDate)}</s-text>
        ) : null}
        {deliveryTime ? <s-text>Time slot: {deliveryTime}</s-text> : null}
      </s-stack>
    </s-section>
  );
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