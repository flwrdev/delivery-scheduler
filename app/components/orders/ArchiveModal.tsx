// Bulk "Archive selected orders" confirmation modal. JSX moved verbatim from
// app.orders.tsx Extension(); keeps its document-wide id
// ("modal-archive-orders") so useBulkActions' showModal()/hideModal() calls
// keep working unchanged.
export interface ArchiveModalProps {
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function ArchiveModal({
  selectedCount,
  isSubmitting,
  onConfirm,
}: ArchiveModalProps) {
  return (
    <s-modal
      id="modal-archive-orders"
      heading="Archive selected orders?"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-banner tone="warning">
            <s-paragraph>
              {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
              be archived and hidden from the main orders view. You can
              unarchive them later.
            </s-paragraph>
          </s-banner>
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-archive-orders"
        command="--hide"
        disabled={isSubmitting}
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={isSubmitting || selectedCount === 0}
        onClick={onConfirm}
      >
        {isSubmitting
          ? "Archiving…"
          : `Archive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
      </s-button>
    </s-modal>
  );
}
