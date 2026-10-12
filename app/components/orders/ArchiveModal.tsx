// Confirmation modal for archiving the selected orders (the `archive` bulk action).

import { Banner, Modal, Text } from "@shopify/polaris";

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
      title="Archive orders?"
      primaryAction={{
        content: isSubmitting
          ? "Archiving…"
          : `Archive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
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
            {selectedCount} {selectedCount === 1 ? "order" : "orders"} will move
            to Archived. You can unarchive them anytime.
          </Text>
        </Banner>
      </Modal.Section>
    </Modal>
  );
}
