import { tagDisplayLabel } from "../../../../app/lib/order-utils";

export const BULK_MODAL_ID = "orders-bulk-modal";

const CANCEL_REASON_OPTIONS = [
  { label: "Customer request", value: "CUSTOMER" },
  { label: "Insufficient inventory", value: "INVENTORY" },
  { label: "Payment declined", value: "DECLINED" },
  { label: "Fraud", value: "FRAUD" },
  { label: "Staff error", value: "STAFF" },
  { label: "Other", value: "OTHER" },
];

function plural(n) {
  return `${n} ${n === 1 ? "order" : "orders"}`;
}

function modalCopy(name, count, isSubmitting) {
  switch (name) {
    case "archive":
      return {
        heading: "Archive selected orders?",
        confirm: isSubmitting ? "Archiving…" : `Archive ${plural(count)}`,
      };
    case "unarchive":
      return {
        heading: "Unarchive selected orders?",
        confirm: isSubmitting ? "Unarchiving…" : `Unarchive ${plural(count)}`,
      };
    case "markAsPaid":
      return {
        heading: "Mark selected orders as paid?",
        confirm: isSubmitting ? "Marking as paid…" : `Mark ${plural(count)} as paid`,
      };
    case "cancel":
      return {
        heading: "Cancel selected orders?",
        confirm: isSubmitting ? "Cancelling…" : `Cancel ${plural(count)}`,
        critical: true,
        dismiss: "Keep them",
      };
    case "addTags":
      return {
        heading: "Add tags to selected orders",
        confirm: isSubmitting ? "Adding…" : "Add tags",
      };
    case "removeTags":
      return {
        heading: "Remove tags from selected orders",
        confirm: isSubmitting ? "Removing…" : "Remove tags",
      };
    case "markFulfilled":
      return {
        heading: "Mark selected orders as fulfilled?",
        confirm: isSubmitting ? "Fulfilling…" : `Mark ${plural(count)} fulfilled`,
      };
    default:
      return { heading: "Orders", confirm: "Confirm" };
  }
}

function ModalBody({ name, count, form, suggestedTags }) {
  if (name === "archive") {
    return (
      <s-banner tone="warning">
        {`${plural(count)} will be archived and hidden from the main orders view. You can unarchive them later.`}
      </s-banner>
    );
  }
  if (name === "unarchive") {
    return (
      <s-banner tone="info">
        {`${plural(count)} will be unarchived and returned to the main orders view.`}
      </s-banner>
    );
  }
  if (name === "markAsPaid") {
    return (
      <s-banner tone="warning">
        {`${plural(count)} will be marked as fully paid. This captures the outstanding balance and cannot be undone from here.`}
      </s-banner>
    );
  }
  if (name === "cancel") {
    return (
      <s-stack gap="base">
        <s-banner tone="critical">
          {`${plural(count)} will be cancelled. Cancellation is irreversible.`}
        </s-banner>
        <s-select
          label="Cancellation reason"
          value={form.cancelReason}
          onChange={(e) => form.setCancelReason(e.currentTarget.value)}
        >
          {CANCEL_REASON_OPTIONS.map((o) => (
            <s-option key={o.value} value={o.value}>
              {o.label}
            </s-option>
          ))}
        </s-select>
        <s-checkbox
          label="Restock inventory committed to these orders"
          checked={form.cancelRestock}
          onChange={(e) => form.setCancelRestock(e.currentTarget.checked)}
        />
        <s-checkbox
          label="Notify customers by email"
          checked={form.cancelNotify}
          onChange={(e) => form.setCancelNotify(e.currentTarget.checked)}
        />
        <s-text-field
          label="Staff note (optional, internal only)"
          value={form.cancelStaffNote}
          maxLength={255}
          onInput={(e) => form.setCancelStaffNote(e.currentTarget.value)}
        />
      </s-stack>
    );
  }
  if (name === "addTags") {
    return (
      <s-stack gap="base">
        <s-paragraph>{`Add the tags below to ${plural(count)}.`}</s-paragraph>
        <s-text-field
          label="Tags (comma-separated)"
          placeholder="e.g. priority, vip"
          value={form.addTagsInput}
          onInput={(e) => form.setAddTagsInput(e.currentTarget.value)}
        />
      </s-stack>
    );
  }
  if (name === "removeTags") {
    const appendSuggestion = (tag) => {
      const current = form.removeTagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (current.includes(tag)) return;
      form.setRemoveTagsInput([...current, tag].join(", "));
    };
    return (
      <s-stack gap="base">
        <s-paragraph>{`Remove the tags below from ${plural(count)}.`}</s-paragraph>
        <s-text-field
          label="Tags (comma-separated)"
          placeholder="e.g. priority, vip"
          value={form.removeTagsInput}
          onInput={(e) => form.setRemoveTagsInput(e.currentTarget.value)}
        />
        {suggestedTags.length > 0 && (
          <s-stack gap="small">
            <s-text color="subdued">Tags on the selected orders — click to add:</s-text>
            <s-stack direction="inline" gap="small-300">
              {suggestedTags.map((tag) => (
                <s-clickable-chip key={tag} onClick={() => appendSuggestion(tag)}>
                  {tagDisplayLabel(tag)}
                </s-clickable-chip>
              ))}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    );
  }
  if (name === "markFulfilled") {
    return (
      <s-stack gap="base">
        <s-banner tone="warning">
          {`This creates a real Shopify fulfillment for ${plural(count)}. Customers will receive a notification email if "Notify customer" is enabled.`}
        </s-banner>
        <s-url-field
          label="Tracking URL (optional)"
          placeholder="https://tracking.example.com/…"
          value={form.fulfillTrackingUrl}
          onInput={(e) => form.setFulfillTrackingUrl(e.currentTarget.value)}
        />
        <s-checkbox
          label="Notify customer by email"
          checked={form.fulfillNotify}
          onChange={(e) => form.setFulfillNotify(e.currentTarget.checked)}
        />
      </s-stack>
    );
  }
  return null;
}

export function BulkModal({ modalRef, name, count, isSubmitting, form, suggestedTags, onConfirm, onHide }) {
  const copy = modalCopy(name, count, isSubmitting);
  const confirmDisabled =
    isSubmitting ||
    count === 0 ||
    (name === "addTags" && !form.addTagsInput.trim()) ||
    (name === "removeTags" && !form.removeTagsInput.trim());

  return (
    <s-modal id={BULK_MODAL_ID} ref={modalRef} heading={copy.heading} onHide={onHide}>
      {name && <ModalBody name={name} count={count} form={form} suggestedTags={suggestedTags} />}
      <s-button
        slot="primary-action"
        variant="primary"
        tone={copy.critical ? "critical" : "auto"}
        loading={isSubmitting}
        disabled={confirmDisabled}
        onClick={onConfirm}
      >
        {copy.confirm}
      </s-button>
      <s-button
        slot="secondary-actions"
        commandFor={BULK_MODAL_ID}
        command="--hide"
        disabled={isSubmitting}
      >
        {copy.dismiss ?? "Cancel"}
      </s-button>
    </s-modal>
  );
}
