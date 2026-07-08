import { getSafeEventValue } from "../../lib/get-safe-event-value";

// Bulk "Add tags" modal. JSX moved verbatim from app.orders.tsx Extension();
// keeps its document-wide id ("modal-add-tags") so the bulk-menu commandFor
// trigger and useBulkActions hideModal() keep working unchanged.
export interface AddTagsModalProps {
  selectedCount: number;
  isSubmitting: boolean;
  addTagsInput: string;
  setAddTagsInput: (value: string) => void;
  onConfirm: () => void;
}

export function AddTagsModal({
  selectedCount,
  isSubmitting,
  addTagsInput,
  setAddTagsInput,
  onConfirm,
}: AddTagsModalProps) {
  return (
    <s-modal
      id="modal-add-tags"
      heading="Add tags to selected orders"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-text>
            Add the tags below to {selectedCount}{" "}
            {selectedCount === 1 ? "order" : "orders"}.
          </s-text>
          <s-text-field
            id="add-tags-input"
            label="Tags (comma-separated)"
            placeholder="e.g. priority, vip, holiday"
            value={addTagsInput}
            onInput={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
            onChange={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
          />
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-add-tags"
        command="--hide"
        disabled={isSubmitting}
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={isSubmitting || !addTagsInput.trim() || selectedCount === 0}
        onClick={onConfirm}
      >
        {isSubmitting ? "Adding…" : "Add tags"}
      </s-button>
    </s-modal>
  );
}
