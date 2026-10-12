// Modal to add tags to the selected orders. The parent submits the `tagsAdd` bulk action.

import { BlockStack, Modal, Text, TextField } from "@shopify/polaris";

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
      title="Add tags to selected orders"
      primaryAction={{
        content: isSubmitting ? "Adding…" : "Add tags",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled: isSubmitting || !addTagsInput.trim() || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">
            Add the tags below to {selectedCount}{" "}
            {selectedCount === 1 ? "order" : "orders"}.
          </Text>
          <TextField
            label="Tags (comma-separated)"
            placeholder="e.g. priority, vip, holiday"
            value={addTagsInput}
            onChange={setAddTagsInput}
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
