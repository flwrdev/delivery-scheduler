import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Banner, BlockStack, Modal, TextField } from "@shopify/polaris";
import type { SendEmailResponse } from "../../services/send-customer-email.server";

// "Send email" compose modal (customer-email-design.md §4) — opened from the
// details panel's Actions menu, single order only. The To field is display
// only: the server re-reads the customer email from the order id (E-4), so
// nothing typed here can redirect the send. Sends through the merchant's
// business mailbox; writes nothing to the order (E-5).
export interface SendEmailModalProps {
  open: boolean;
  onClose: () => void;
  orderId: string | null;
  orderName: string | null;
  customerEmail: string | null;
}

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

export function SendEmailModal({
  open,
  onClose,
  orderId,
  orderName,
  customerEmail,
}: SendEmailModalProps) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<SendEmailResponse>();
  const isSubmitting = fetcher.state !== "idle";

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset + prefill each time the modal opens (same pattern as
  // RescheduleModal). Subject prefill: "Order #XXXX".
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSubject(orderName ? `Order ${orderName}` : "");
      setBody("");
      setError(null);
    }
    wasOpenRef.current = open;
  }, [open, orderName]);

  // Success → toast + close. Failure → banner INSIDE the modal so the typed
  // message is never lost; fields stay editable for retry.
  const handledDataRef = useRef<SendEmailResponse | null>(null);
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledDataRef.current === fetcher.data) return;
    handledDataRef.current = fetcher.data;
    if (fetcher.data.ok) {
      shopify.toast.show(fetcher.data.message);
      onClose();
    } else {
      setError(fetcher.data.message || "Failed to send the email.");
    }
  }, [fetcher.data, fetcher.state, shopify, onClose]);

  const canSend =
    !isSubmitting &&
    Boolean(orderId) &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  const handleSend = () => {
    if (!orderId) return;
    setError(null);
    const fd = new FormData();
    fd.append("_action", "sendEmail");
    fd.append("orderId", orderId);
    fd.append("subject", subject);
    fd.append("body", body);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send email"
      primaryAction={{
        content: isSubmitting ? "Sending…" : "Send email",
        onAction: handleSend,
        loading: isSubmitting,
        disabled: !canSend,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error && (
            <Banner tone="critical" title="The email was not sent">
              <p>{error}</p>
            </Banner>
          )}
          <TextField
            label="To"
            value={customerEmail ?? ""}
            disabled
            autoComplete="off"
          />
          <TextField
            label="Subject"
            value={subject}
            onChange={setSubject}
            disabled={isSubmitting}
            maxLength={MAX_SUBJECT}
            autoComplete="off"
          />
          <TextField
            label="Message"
            value={body}
            onChange={setBody}
            disabled={isSubmitting}
            multiline={6}
            maxLength={MAX_BODY}
            showCharacterCount
            autoComplete="off"
            helpText="Sent as plain text from your business mailbox. A copy is BCC'd to you."
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
