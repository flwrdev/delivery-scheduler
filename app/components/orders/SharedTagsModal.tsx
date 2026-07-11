import { InlineStack, Modal, Tag, Text } from "@shopify/polaris";
import { tagDisplayLabel } from "../../lib/order-utils";

// Shared row-level tags/attributes modal — one instance reused by every table
// row's "+N" button (Polaris React). Visibility is controlled by the parent
// via `open`/`onClose`; the old counter-prop + ref show() hack is gone
// (audit B1: third modal-trigger pattern).
export interface SharedTagsModalProps {
  open: boolean;
  onClose: () => void;
  tags: string[];
}

export function SharedTagsModal({ open, onClose, tags }: SharedTagsModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Attributes"
      primaryAction={{ content: "Close", onAction: onClose }}
    >
      <Modal.Section>
        {tags.length === 0 ? (
          <Text as="p" tone="subdued">
            No tags on this order.
          </Text>
        ) : (
          <InlineStack gap="100" wrap>
            {tags.map((tag) => (
              <Tag key={tag}>{tagDisplayLabel(tag)}</Tag>
            ))}
          </InlineStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
