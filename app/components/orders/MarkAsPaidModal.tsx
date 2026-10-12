// Confirmation modal for marking the selected orders as paid (the `markAsPaid` bulk action).

import { Banner, Modal, Text } from "@shopify/polaris";

// Bulk "Mark selected orders as paid" confirmation modal (Polaris React).
// Visibility is controlled by the parent via `open`/`onClose`.
export interface MarkAsPaidModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function MarkAsPaidModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: MarkAsPaidModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark orders as paid?"
      primaryAction={{
        content: isSubmitting
          ? "Marking as paid…"
          : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} as paid`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <Banner tone="warning">
          <Text as="p">
            {selectedCount} {selectedCount === 1 ? "order" : "orders"} will be
            marked as paid. You can’t undo this here.
          </Text>
        </Banner>
      </Modal.Section>
    </Modal>
  );
}
