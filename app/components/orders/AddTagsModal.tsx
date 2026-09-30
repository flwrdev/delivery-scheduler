import { Modal, TextField } from "@shopify/polaris";

// Bulk "Add tags" modal (Polaris React). Visibility is controlled by the
// parent via `open`/`onClose`.
export interface AddTagsModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  addTagsInput: string;
  setAddTagsInput: (value: string) => void;
  onConfirm: () => void;
}

export function AddTagsModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  addTagsInput,
  setAddTagsInput,
  onConfirm,
}: AddTagsModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add tags to ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
      primaryAction={{
        content: "Add tags",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || !addTagsInput.trim() || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <TextField
          label="Tags"
          helpText="Separate tags with commas."
          placeholder="priority, vip"
          value={addTagsInput}
          onChange={setAddTagsInput}
          autoComplete="off"
        />
      </Modal.Section>
    </Modal>
  );
}
