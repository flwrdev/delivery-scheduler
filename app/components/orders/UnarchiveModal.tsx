// Bulk "Unarchive selected orders" confirmation modal. JSX moved verbatim
// from app.orders.tsx Extension(); keeps its document-wide id
// ("modal-unarchive-orders") so useBulkActions' showModal()/hideModal() calls
// keep working unchanged.
export interface UnarchiveModalProps {
  selectedCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
}

export function UnarchiveModal({
  selectedCount,
  isSubmitting,
  onConfirm,
}: UnarchiveModalProps) {
  return (
    <s-modal
      id="modal-unarchive-orders"
      heading="Unarchive selected orders?"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-banner tone="info">
            <s-paragraph>
              {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
              be unarchived and returned to the main orders view.
            </s-paragraph>
          </s-banner>
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-unarchive-orders"
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
          ? "Unarchiving…"
          : `Unarchive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
      </s-button>
    </s-modal>
  );
}
