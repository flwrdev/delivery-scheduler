import {
  Banner,
  BlockStack,
  Checkbox,
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

// Bulk "Cancel selected orders" confirmation modal (Polaris React).
// Visibility is controlled by the parent via `open`/`onClose` — closing on
// action success is plain React state in useBulkActions (fixes audit S2).
export interface CancelModalProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  isSubmitting: boolean;
  cancelReason: string;
  setCancelReason: (value: string) => void;
  cancelRestock: boolean;
  setCancelRestock: (value: boolean) => void;
  cancelNotify: boolean;
  setCancelNotify: (value: boolean) => void;
  cancelStaffNote: string;
  setCancelStaffNote: (value: string) => void;
  onConfirm: () => void;
}

const CANCEL_REASON_OPTIONS = [
  { label: "Customer request", value: "CUSTOMER" },
  { label: "Insufficient inventory", value: "INVENTORY" },
  { label: "Payment declined", value: "DECLINED" },
  { label: "Fraud", value: "FRAUD" },
  { label: "Staff error", value: "STAFF" },
  { label: "Other", value: "OTHER" },
];

export function CancelModal({
  open,
  onClose,
  selectedCount,
  isSubmitting,
  cancelReason,
  setCancelReason,
  cancelRestock,
  setCancelRestock,
  cancelNotify,
  setCancelNotify,
  cancelStaffNote,
  setCancelStaffNote,
  onConfirm,
}: CancelModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel selected orders?"
      primaryAction={{
        content: isSubmitting
          ? "Cancelling…"
          : `Cancel ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`,
        onAction: onConfirm,
        destructive: true,
        loading: isSubmitting,
        disabled: isSubmitting || selectedCount === 0,
      }}
      secondaryActions={[
        { content: "Keep them", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="critical">
            <Text as="p">
              {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
              be cancelled. Cancellation is irreversible.
            </Text>
          </Banner>
          <Select
            label="Cancellation reason"
            options={CANCEL_REASON_OPTIONS}
            value={cancelReason}
            onChange={setCancelReason}
          />
          <Checkbox
            label="Restock inventory committed to these orders"
            checked={cancelRestock}
            onChange={setCancelRestock}
          />
          <Checkbox
            label="Notify customers by email"
            checked={cancelNotify}
            onChange={setCancelNotify}
          />
          <TextField
            label="Staff note (optional, internal only)"
            value={cancelStaffNote}
            onChange={setCancelStaffNote}
            maxLength={255}
            showCharacterCount
            autoComplete="off"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
