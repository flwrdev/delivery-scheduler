import { Modal, Text } from "@shopify/polaris";

// Bulk "Archive selected orders" confirmation modal (Polaris React).
// Visibility is controlled by the parent via `open`/`onClose` — no DOM ids,
// no command API (fixes audit S1: the imperative s-modal open path).
export interface ArchiveModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function ArchiveModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  onConfirm,
}: ArchiveModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Archive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}?`}
      primaryAction={{
        content: selectedCount === 1 ? "Archive order" : "Archive orders",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <Text as="p">
          Archived orders move to the Archived tab. You can unarchive them
          anytime.
        </Text>
      </Modal.Section>
    </Modal>
  );
}
