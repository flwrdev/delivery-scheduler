import { Modal, Text } from "@shopify/polaris";

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
      title={`Unarchive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}?`}
      primaryAction={{
        content: selectedCount === 1 ? "Unarchive order" : "Unarchive orders",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <Text as="p">These orders will show in the main list again.</Text>
      </Modal.Section>
    </Modal>
  );
}
