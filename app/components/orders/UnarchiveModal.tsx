import { Banner, Modal, Text } from "@shopify/polaris";

// Bulk "Unarchive selected orders" confirmation modal (Polaris React).
// Visibility is controlled by the parent via `open`/`onClose`.
export interface UnarchiveModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function UnarchiveModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: UnarchiveModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Unarchive selected orders?"
      primaryAction={{
        content: isSubmitting
          ? "Unarchiving…"
          : `Unarchive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <Banner tone="info">
          <Text as="p">
            {selectedCount} {selectedCount === 1 ? "order" : "orders"} will be
            unarchived and returned to the main orders view.
          </Text>
        </Banner>
      </Modal.Section>
    </Modal>
  );
}
