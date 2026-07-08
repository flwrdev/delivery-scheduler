import type { ChangeEvent } from "react";
import { getSafeEventValue } from "../../lib/get-safe-event-value";

// Bulk "Mark as fulfilled" modal (tracking fields + optional bouquet-photo
// upload with preview). JSX moved verbatim from app.orders.tsx Extension();
// all form state lives in useBulkActions and arrives via props. Keeps its
// document-wide id ("modal-mark-fulfilled") so the bulk-menu commandFor
// trigger and useBulkActions hideModal() keep working unchanged.
export interface MarkFulfilledModalProps {
  selectedCount: number;
  isSubmitting: boolean;
  fulfillTrackingNumber: string;
  setFulfillTrackingNumber: (value: string) => void;
  fulfillTrackingUrl: string;
  setFulfillTrackingUrl: (value: string) => void;
  fulfillNotify: boolean;
  setFulfillNotify: (value: boolean) => void;
  fulfillPhotoPreview: string;
  fulfillPhotoError: string;
  onPhotoChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onConfirm: () => void;
}

export function MarkFulfilledModal({
  selectedCount,
  isSubmitting,
  fulfillTrackingNumber,
  setFulfillTrackingNumber,
  fulfillTrackingUrl,
  setFulfillTrackingUrl,
  fulfillNotify,
  setFulfillNotify,
  fulfillPhotoPreview,
  fulfillPhotoError,
  onPhotoChange,
  onConfirm,
}: MarkFulfilledModalProps) {
  return (
    <s-modal
      id="modal-mark-fulfilled"
      heading="Mark selected orders as fulfilled?"
      size="small"
    >
      <s-box padding="base">
        <s-stack direction="block" gap="base">
          <s-banner tone="warning">
            <s-paragraph>
              This creates a real Shopify fulfillment for {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}. Customers will
              receive a notification email if &quot;Notify customer&quot; is
              enabled.
            </s-paragraph>
          </s-banner>
          <s-text-field
            id="fulfill-tracking-number"
            label="Tracking number (optional)"
            placeholder="e.g. 1Z999AA10123456784"
            value={fulfillTrackingNumber}
            onInput={(e: Event) =>
              setFulfillTrackingNumber(getSafeEventValue(e))
            }
            onChange={(e: Event) =>
              setFulfillTrackingNumber(getSafeEventValue(e))
            }
          />
          <s-text-field
            id="fulfill-tracking-url"
            label="Tracking URL (optional)"
            placeholder="https://tracking.example.com/…"
            value={fulfillTrackingUrl}
            onInput={(e: Event) =>
              setFulfillTrackingUrl(getSafeEventValue(e))
            }
            onChange={(e: Event) =>
              setFulfillTrackingUrl(getSafeEventValue(e))
            }
          />
          <s-checkbox
            label="Notify customer by email"
            checked={fulfillNotify}
            onChange={(e: Event) =>
              setFulfillNotify((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              htmlFor="fulfill-photo-input"
              style={{ fontSize: 13, fontWeight: 500, color: "#202223" }}
            >
              Bouquet Photo (optional)
            </label>
            <input
              id="fulfill-photo-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ fontSize: 13 }}
              onChange={onPhotoChange}
            />
            {fulfillPhotoError && (
              <p style={{ margin: 0, fontSize: 13, color: "#d72c0d" }}>
                {fulfillPhotoError}
              </p>
            )}
            {fulfillPhotoPreview && (
              <img
                src={fulfillPhotoPreview}
                alt="Bouquet preview"
                style={{
                  marginTop: 4,
                  maxWidth: 120,
                  maxHeight: 120,
                  objectFit: "cover",
                  borderRadius: 6,
                  border: "1px solid #e1e3e5",
                }}
              />
            )}
          </div>
        </s-stack>
      </s-box>
      <s-button
        slot="secondary-actions"
        commandFor="modal-mark-fulfilled"
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
          ? "Fulfilling…"
          : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} fulfilled`}
      </s-button>
    </s-modal>
  );
}
