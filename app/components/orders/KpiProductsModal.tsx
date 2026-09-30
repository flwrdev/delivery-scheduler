import { BlockStack, InlineStack, Modal, Text } from "@shopify/polaris";

// "Items to prepare" modal, opened from the Orders KPI card (Polaris React).
// Visibility is controlled by the parent via `open`/`onClose`.
export interface KpiProductsModalProps {
  open: boolean;
  onClose: () => void;
  kpiProducts: [string, number][];
}

export function KpiProductsModal({
  open,
  onClose,
  kpiProducts,
}: KpiProductsModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Items to prepare"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      <Modal.Section>
        {kpiProducts.length === 0 ? (
          <Text as="p" tone="subdued">
            No products found.
          </Text>
        ) : (
          <BlockStack gap="150">
            {kpiProducts.map(([name, qty]) => (
              <InlineStack key={name} align="space-between" blockAlign="center">
                <Text as="span">{name}</Text>
                <Text as="span" fontWeight="semibold">
                  × {qty}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
