import { BlockStack, Text } from "@shopify/polaris";
import { type Order, formatMoney } from "../../../lib/order-utils";

export function ItemsSection({ order }: { order: Order }) {
  const items = order.lineItems?.edges || [];

  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const shippingAmount = order.totalShippingPriceSet
    ? parseFloat(order.totalShippingPriceSet.shopMoney.amount)
    : 0;
  const totalAmount = order.currentTotalPriceSet
    ? parseFloat(order.currentTotalPriceSet.shopMoney.amount)
    : 0;
  const currencyCode =
    order.currentTotalPriceSet?.shopMoney.currencyCode ||
    order.totalShippingPriceSet?.shopMoney.currencyCode ||
    "USD";
  const subtotalFormatted = order.currentTotalPriceSet
    ? formatMoney((totalAmount - shippingAmount).toFixed(2), currencyCode)
    : "—";
  const shippingFormatted = order.totalShippingPriceSet
    ? formatMoney(order.totalShippingPriceSet.shopMoney.amount, currencyCode)
    : "—";

  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">
        Items ({items.length})
      </Text>
      {items.length === 0 ? (
        <Text as="p" tone="subdued">
          No items.
        </Text>
      ) : (
        <div>
          {items.map((edge, idx) => {
            const item = edge.node;
            const imgUrl = item.image?.url || item.product?.featuredImage?.url;
            const imgAlt =
              item.image?.altText ||
              item.product?.featuredImage?.altText ||
              item.name;
            return (
              <div key={idx} className="odp-item-row">
                {imgUrl ? (
                  <img className="odp-item-thumb" src={imgUrl} alt={imgAlt} />
                ) : (
                  <div className="odp-item-thumb-placeholder" />
                )}
                <div className="odp-item-info">
                  <Text as="p" fontWeight="medium" truncate>
                    {item.name}
                  </Text>
                  {item.sku && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      SKU: {item.sku}
                    </Text>
                  )}
                </div>
                <Text as="span" tone="subdued">
                  × {item.quantity}
                </Text>
              </div>
            );
          })}
        </div>
      )}
      <div className="odp-totals">
        <div className="odp-totals-row">
          <Text as="span" tone="subdued">
            Subtotal
          </Text>
          <Text as="span">{subtotalFormatted}</Text>
        </div>
        <div className="odp-totals-row">
          <Text as="span" tone="subdued">
            Shipping fee
          </Text>
          <Text as="span">{shippingFormatted}</Text>
        </div>
        <div className="odp-totals-row">
          <Text as="span" fontWeight="semibold">
            Total
          </Text>
          <Text as="span" fontWeight="semibold">
            {total}
          </Text>
        </div>
      </div>
    </BlockStack>
  );
}
