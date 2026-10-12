// Modal to write an email to the customer of an order, with up to three photos. Submits the
// `sendEmail` action as multipart form data.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  DropZone,
  InlineStack,
  Modal,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import type { SendEmailResponse } from "../../services/send-customer-email.server";
import { replySubject } from "../../lib/email-replies";

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
  replyTo?: { subject: string; messageId: string | null } | null;
}

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

// E-8 photo caps — mirror the authoritative server-side limits in
// send-customer-email.server.ts (client checks are UX only).
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS_TOTAL_BYTES = 15 * 1024 * 1024;
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function SendEmailModal({
  open,
  onClose,
  orderId,
  orderName,
  customerEmail,
  replyTo = null,
}: SendEmailModalProps) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<SendEmailResponse>();
  const isSubmitting = fetcher.state !== "idle";

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Reset + prefill each time the modal opens (same pattern as
  // RescheduleModal). Subject prefill: "Order #XXXX".
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      // The added "Re: " can push a max-length subject past the server's cap.
      setSubject(
        replyTo
          ? replySubject(replyTo.subject).slice(0, MAX_SUBJECT)
          : orderName
            ? `Order ${orderName}`
            : "",
      );
      setBody("");
      setPhotos([]);
      setError(null);
      setPhotoError(null);
    }
    wasOpenRef.current = open;
  }, [open, orderName, replyTo]);

  // Thumbnail previews need object URLs, which must be revoked on change.
  const photoPreviews = useMemo(
    () => photos.map((file) => URL.createObjectURL(file)),
    [photos],
  );
  useEffect(() => {
    return () => {
      for (const url of photoPreviews) URL.revokeObjectURL(url);
    };
  }, [photoPreviews]);

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

  const handleDropPhotos = (_dropped: File[], accepted: File[]) => {
    setPhotoError(null);
    const next = [...photos];
    const rejected: string[] = [];
    for (const file of accepted) {
      if (next.length >= MAX_PHOTOS) {
        rejected.push(`only ${MAX_PHOTOS} photos per email`);
        break;
      }
      if (!PHOTO_TYPES.includes(file.type)) {
        rejected.push(`"${file.name}" is not a JPEG/PNG/WebP image`);
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        rejected.push(`"${file.name}" is over ${mb(MAX_PHOTO_BYTES)}`);
        continue;
      }
      if (
        next.reduce((sum, f) => sum + f.size, 0) + file.size >
        MAX_PHOTOS_TOTAL_BYTES
      ) {
        rejected.push(`photos are ${mb(MAX_PHOTOS_TOTAL_BYTES)} max in total`);
        continue;
      }
      next.push(file);
    }
    setPhotos(next);
    if (rejected.length) {
      setPhotoError(`Some photos were not added: ${rejected.join("; ")}.`);
    }
  };

  const removePhoto = (index: number) => {
    setPhotoError(null);
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

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
    if (replyTo?.messageId) fd.append("inReplyTo", replyTo.messageId);
    for (const photo of photos) fd.append("photo", photo, photo.name);
    // multipart: the photos must survive serialization; the route action's
    // request.formData() parses multipart natively, with or without files.
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={replyTo ? "Reply to customer" : "Send email"}
      primaryAction={{
        content: isSubmitting ? "Sending…" : replyTo ? "Send reply" : "Send email",
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
          <BlockStack gap="200">
            {photoError && (
              <Banner tone="warning">
                <p>{photoError}</p>
              </Banner>
            )}
            {photos.length < MAX_PHOTOS && (
              <DropZone
                accept={PHOTO_ACCEPT}
                type="image"
                allowMultiple
                disabled={isSubmitting}
                onDrop={handleDropPhotos}
                variableHeight
              >
                <DropZone.FileUpload
                  actionTitle="Add photos"
                  actionHint={`JPEG, PNG, or WebP · up to ${MAX_PHOTOS} photos, ${mb(MAX_PHOTO_BYTES)} each`}
                />
              </DropZone>
            )}
            {photos.map((photo, index) => (
              <InlineStack
                key={`${photo.name}-${index}`}
                gap="300"
                blockAlign="center"
                wrap={false}
              >
                <Thumbnail
                  source={photoPreviews[index]}
                  alt={photo.name}
                  size="small"
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text as="span" variant="bodySm" truncate>
                    {photo.name}
                  </Text>
                </div>
                <Button
                  variant="plain"
                  tone="critical"
                  onClick={() => removePhoto(index)}
                  disabled={isSubmitting}
                >
                  Remove
                </Button>
              </InlineStack>
            ))}
            {photos.length > 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                Photos are sent to the customer only — your mailbox copy lists
                them without the attachments to save storage space.
              </Text>
            )}
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
