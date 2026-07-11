import { BlockStack, InlineStack, Modal, Tag, Text, TextField } from "@shopify/polaris";
import { tagDisplayLabel } from "../../lib/order-utils";

// Bulk "Remove tags" modal (Polaris React). Visibility is controlled by the
// parent via `open`/`onClose`. `suggestedTags` (audit S4) is the union of the
// selected orders' meaningful tags, computed client-side from already-loaded
// data — clicking one appends the RAW tag to the input, so the merchant never
// has to type an exact tag from memory. Schedule/system tags are excluded
// upstream by getMeaningfulTags, so they can't be removed by accident here.
export interface RemoveTagsModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  removeTagsInput: string;
  setRemoveTagsInput: (value: string) => void;
  suggestedTags: string[];
  onConfirm: () => void;
}

export function RemoveTagsModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  removeTagsInput,
  setRemoveTagsInput,
  suggestedTags,
  onConfirm,
}: RemoveTagsModalProps) {
  const appendSuggestion = (tag: string) => {
    const current = removeTagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (current.includes(tag)) return;
    setRemoveTagsInput([...current, tag].join(", "));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remove tags from selected orders"
      primaryAction={{
        content: isSubmitting ? "Removing…" : "Remove tags",
        onAction: onConfirm,
        loading: isSubmitting,
        disabled:
          isSubmitting || !removeTagsInput.trim() || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">
            Remove the tags below from {selectedCount}{" "}
            {selectedCount === 1 ? "order" : "orders"}.
          </Text>
          <TextField
            label="Tags (comma-separated)"
            placeholder="e.g. priority, vip"
            value={removeTagsInput}
            onChange={setRemoveTagsInput}
            autoComplete="off"
          />
          {suggestedTags.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">
                Tags on the selected orders — click to add:
              </Text>
              <InlineStack gap="100" wrap>
                {suggestedTags.map((tag) => (
                  <Tag key={tag} onClick={() => appendSuggestion(tag)}>
                    {tagDisplayLabel(tag)}
                  </Tag>
                ))}
              </InlineStack>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
