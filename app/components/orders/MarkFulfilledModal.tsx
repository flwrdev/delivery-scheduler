// Modal for fulfilling the selected orders, with an optional tracking URL and a choice to notify
// the customers (the `markFulfilled` bulk action).

import {
  Banner,
  BlockStack,
  Checkbox,
  Modal,
  Text,
  TextField,
} from "@shopify/polaris";

// Bulk "Mark as fulfilled" modal (Polaris React): tracking fields + notify
// toggle. Visibility is controlled by the parent via `open`/`onClose`; all
// form state lives in useBulkActions.
export interface MarkFulfilledModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  fulfillTrackingUrl: string;
  setFulfillTrackingUrl: (value: string) => void;
  fulfillNotify: boolean;
  setFulfillNotify: (value: boolean) => void;
  onConfirm: () => void;
}

export function MarkFulfilledModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  fulfillTrackingUrl,
  setFulfillTrackingUrl,
  fulfillNotify,
  setFulfillNotify,
  onConfirm,
}: MarkFulfilledModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark orders as fulfilled?"
      primaryAction={{
        content: isSubmitting
          ? "Fulfilling…"
          : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} fulfilled`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="warning">
            <Text as="p">
              This creates a Shopify fulfillment for {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}.
            </Text>
          </Banner>
          <TextField
            label="Tracking URL (optional)"
            placeholder="https://tracking.example.com/…"
            value={fulfillTrackingUrl}
            onChange={setFulfillTrackingUrl}
            autoComplete="off"
          />
          <Checkbox
            label="Notify customer by email"
            checked={fulfillNotify}
            onChange={setFulfillNotify}
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
