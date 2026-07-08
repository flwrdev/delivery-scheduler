import { getSafeEventValue } from "../../lib/get-safe-event-value";

// Bulk "Remove tags" modal. JSX moved verbatim from app.orders.tsx
// Extension(); keeps its document-wide id ("modal-remove-tags") so the
// bulk-menu commandFor trigger and useBulkActions hideModal() keep working
// unchanged.
export interface RemoveTagsModalProps {
  selectedCount: number;
  isSubmitting: boolean;
  removeTagsInput: string;
  setRemoveTagsInput: (value: string) => void;
  onConfirm: () => void;
}

export function RemoveTagsModal({
  selectedCount,
  isSubmitting,
  removeTagsInput,
  setRemoveTagsInput,
  onConfirm,
}: RemoveTagsModalProps) {
  return (
    <s-modal
      id="modal-remove-tags"
      heading="Remove tags from selected orders"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-text>
            Remove the tags below from {selectedCount}{" "}
            {selectedCount === 1 ? "order" : "orders"}.
          </s-text>
          <s-text-field
            id="remove-tags-input"
            label="Tags (comma-separated)"
            placeholder="e.g. priority, vip"
            value={removeTagsInput}
            onInput={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
            onChange={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
          />
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-remove-tags"
        command="--hide"
        disabled={isSubmitting}
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={
          isSubmitting || !removeTagsInput.trim() || selectedCount === 0
        }
        onClick={onConfirm}
      >
        {isSubmitting ? "Removing…" : "Remove tags"}
      </s-button>
    </s-modal>
  );
}
