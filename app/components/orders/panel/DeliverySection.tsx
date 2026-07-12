import type { ReactNode } from "react";
import { Badge, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  type Order,
  toLocalISODate,
  formatDeliveryDate,
  financialStatusTone,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  formatStatusLabel,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getDeliveryStatus,
  getOrderPhone,
  getCity,
  getFullShippingAddress,
  buildDeliveryInfoText,
  findAttrValue,
  getAttr,
} from "../../../lib/order-utils";
import { polarisBadgeTone } from "./badge-tone";

function CopyableValue({
  fieldKey,
  value,
  copied,
  onCopy,
}: {
  fieldKey: string;
  value: string;
  copied: boolean;
  onCopy: (fieldKey: string, value: string) => void;
}) {
  if (value === "—") {
    return (
      <Text as="span" tone="subdued">
        —
      </Text>
    );
  }
  return (
    <span
      className={`odp-copyable${copied ? " odp-copyable--copied" : ""}`}
      role="button"
      tabIndex={0}
      title="Click to copy"
      onClick={() => onCopy(fieldKey, value)}
      onKeyDown={(e) => e.key === "Enter" && onCopy(fieldKey, value)}
    >
      <Text as="span">{copied ? "Copied!" : value}</Text>
    </span>
  );
}

export function DeliverySection({ order }: { order: Order }) {
  const { copied, fieldCopied, copyText, copyField } = useCopyToClipboard();

  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const todayISO = toLocalISODate(new Date());
  const isOpenOrder = isOpenDeliverableOrder(order);
  const ffBadge = fulfillmentBadge(order);
  const deliveryRelative =
    rawDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDate, todayISO);
  const timeWindow = getDeliveryTimeValue(order);
  const deliveryStatus = getDeliveryStatus(order);
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const province = order.shippingAddress?.province ?? null;
  const attrs = order.customAttributes || [];
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  // Attribute-sourced instructions only — order.note renders separately below
  // as "Customer notes" so the same text never shows twice.
  const instruction =
    findAttrValue(
      attrs,
      "Instruction",
      "Delivery Instruction",
      "Special Instruction",
      "Special Instructions",
      "delivery_instruction",
      "instruction",
    ) ?? "—";
  const customerNote = order.note?.trim() || "—";
  const senderPhone = getOrderPhone(order);

  const rows: Array<{ label: string; content: ReactNode }> = [
    {
      label: "Delivery date",
      content: (
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" fontWeight="medium">
            {deliveryDate}
          </Text>
          {deliveryRelative && (
            <Badge
              tone={
                deliveryOverdue
                  ? "critical"
                  : deliveryRelative === "Today"
                    ? "attention"
                    : undefined
              }
              size="small"
            >
              {deliveryOverdue ? `Overdue · ${deliveryRelative}` : deliveryRelative}
            </Badge>
          )}
        </InlineStack>
      ),
    },
    {
      label: "Time slot",
      content: <Text as="span">{timeWindow}</Text>,
    },
    {
      label: "Delivery status",
      content: (
        <Badge tone={polarisBadgeTone(deliveryStatus.tone)} size="small">
          {deliveryStatus.label}
        </Badge>
      ),
    },
    {
      label: "Fulfillment",
      content: (
        <Badge tone={polarisBadgeTone(ffBadge.tone)} size="small">
          {ffBadge.label}
        </Badge>
      ),
    },
    {
      label: "Payment",
      content: (
        <Badge
          tone={polarisBadgeTone(
            financialStatusTone(order.displayFinancialStatus),
          )}
          size="small"
        >
          {formatStatusLabel(order.displayFinancialStatus)}
        </Badge>
      ),
    },
    {
      label: "Address",
      content: (
        <CopyableValue
          fieldKey="address"
          value={fullAddress}
          copied={fieldCopied === "address"}
          onCopy={copyField}
        />
      ),
    },
    {
      label: "City",
      content: (
        <CopyableValue
          fieldKey="city"
          value={city}
          copied={fieldCopied === "city"}
          onCopy={copyField}
        />
      ),
    },
  ];

  if (province) {
    rows.push({
      label: "Province",
      content: (
        <CopyableValue
          fieldKey="province"
          value={province}
          copied={fieldCopied === "province"}
          onCopy={copyField}
        />
      ),
    });
  }

  rows.push(
    {
      label: "Card message",
      content: (
        <div className={cardMessage !== "—" ? "odp-dd--scrollable" : undefined}>
          <CopyableValue
            fieldKey="cardMessage"
            value={cardMessage}
            copied={fieldCopied === "cardMessage"}
            onCopy={copyField}
          />
        </div>
      ),
    },
    {
      label: "Instructions",
      content: (
        <div className={instruction !== "—" ? "odp-dd--scrollable" : undefined}>
          <CopyableValue
            fieldKey="instruction"
            value={instruction}
            copied={fieldCopied === "instruction"}
            onCopy={copyField}
          />
        </div>
      ),
    },
    {
      label: "Sender phone",
      content: <Text as="span">{senderPhone}</Text>,
    },
    {
      label: "Customer notes",
      content: (
        <div className={customerNote !== "—" ? "odp-dd--scrollable" : undefined}>
          <Text as="span" tone={customerNote === "—" ? "subdued" : undefined}>
            {customerNote}
          </Text>
        </div>
      ),
    },
  );

  return (
    <BlockStack gap="300">
      <Text as="h3" variant="headingSm">
        Delivery
      </Text>
      <dl className="odp-dl">
        {rows.map((row) => (
          <div style={{ display: "contents" }} key={row.label}>
            <dt className="odp-dt">
              <Text as="span" variant="bodySm" tone="subdued">
                {row.label}
              </Text>
            </dt>
            <dd className="odp-dd">{row.content}</dd>
          </div>
        ))}
      </dl>
      <InlineStack>
        <Button
          size="slim"
          onClick={() => copyText(buildDeliveryInfoText(order))}
        >
          {copied ? "Copied!" : "Copy delivery info"}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
