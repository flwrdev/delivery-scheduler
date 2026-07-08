import { getSafeEventValue } from "../../lib/get-safe-event-value";

// Bulk "Cancel selected orders" confirmation modal. JSX moved verbatim from
// app.orders.tsx Extension(); the modal keeps its document-wide id
// ("modal-cancel-orders") so existing commandFor triggers and the
// useBulkActions hideModal() call keep working unchanged.
export interface CancelModalProps {
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

export function CancelModal({
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
    <s-modal
      id="modal-cancel-orders"
      heading="Cancel selected orders?"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-banner tone="critical">
            <s-paragraph>
              {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
              be cancelled. Cancellation is irreversible.
            </s-paragraph>
          </s-banner>
          <s-select
            id="cancel-reason"
            label="Cancellation reason"
            value={cancelReason}
            onChange={(e: Event) => setCancelReason(getSafeEventValue(e))}
          >
            <s-option value="CUSTOMER">Customer request</s-option>
            <s-option value="INVENTORY">Insufficient inventory</s-option>
            <s-option value="DECLINED">Payment declined</s-option>
            <s-option value="FRAUD">Fraud</s-option>
            <s-option value="STAFF">Staff error</s-option>
            <s-option value="OTHER">Other</s-option>
          </s-select>
          <s-checkbox
            label="Restock inventory committed to these orders"
            checked={cancelRestock}
            onChange={(e: Event) =>
              setCancelRestock((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <s-checkbox
            label="Notify customers by email"
            checked={cancelNotify}
            onChange={(e: Event) =>
              setCancelNotify((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <s-text-field
            id="cancel-staff-note"
            label="Staff note (optional, internal only — max 255 chars)"
            value={cancelStaffNote}
            onInput={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
            onChange={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
          />
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-cancel-orders"
        command="--hide"
        disabled={isSubmitting}
      >
        Keep them
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        disabled={isSubmitting || selectedCount === 0}
        onClick={onConfirm}
      >
        {isSubmitting
          ? "Cancelling…"
          : `Cancel ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
      </s-button>
    </s-modal>
  );
}
