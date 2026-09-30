import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  InlineStack,
  Modal,
  Text,
} from "@shopify/polaris";
import type { MailboxMessage } from "../../lib/email-replies";
import type { QuickReply } from "../../lib/quick-replies";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

export interface EmailViewModalProps {
  open: boolean;
  onClose: () => void;
  message: MailboxMessage | null;
  quickReplies: QuickReply[];
  onReply: (message: MailboxMessage) => void;
}

function formatFullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The text is rendered as a React text node, never as HTML, so nothing a
// sender writes can inject markup into the admin.
export function EmailViewModal({
  open,
  onClose,
  message,
  quickReplies,
  onReply,
}: EmailViewModalProps) {
  const { fieldCopied, copyField } = useCopyToClipboard();
  const [showQuoted, setShowQuoted] = useState(false);

  const messageKey = message?.key ?? null;
  useEffect(() => {
    setShowQuoted(false);
  }, [messageKey, open]);

  if (!message) return null;
  const inbound = message.direction === "inbound";
  const body = showQuoted && message.fullText ? message.fullText : message.text;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={message.subject}
      primaryAction={
        inbound ? { content: "Reply", onAction: () => onReply(message) } : undefined
      }
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" fontWeight="semibold">
              {message.fromName}
            </Text>
            {message.fromName !== message.fromAddress && (
              <Text as="span" tone="subdued">
                &lt;{message.fromAddress}&gt;
              </Text>
            )}
            {inbound && message.verdict === "fail" && (
              <Badge tone="warning">Unverified sender</Badge>
            )}
          </InlineStack>
          {message.toAddresses.length > 0 && (
            <Text as="span" variant="bodySm" tone="subdued">
              To: {message.toAddresses.join(", ")}
            </Text>
          )}
          <Text as="span" variant="bodySm" tone="subdued">
            {formatFullDate(message.date)}
          </Text>
        </BlockStack>
      </Modal.Section>
      <Modal.Section>
        <BlockStack gap="200">
          <span className="odp-email-text">
            <Text as="span">{body || "(no text)"}</Text>
          </span>
          {message.fullText && (
            <span>
              <Button variant="plain" onClick={() => setShowQuoted((v) => !v)}>
                {showQuoted ? "Hide quoted text" : "Show quoted text"}
              </Button>
            </span>
          )}
        </BlockStack>
      </Modal.Section>
      {inbound && (
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Quick replies
            </Text>
            {quickReplies.length > 0 ? (
              <InlineStack gap="200">
                {quickReplies.map((reply, index) => {
                  const key = `quick-reply-${index}`;
                  return (
                    <Button
                      key={key}
                      size="slim"
                      pressed={fieldCopied === key}
                      accessibilityLabel={`Copy quick reply: ${reply.label}`}
                      onClick={() => copyField(key, reply.message)}
                    >
                      {fieldCopied === key ? "Copied" : reply.label}
                    </Button>
                  );
                })}
              </InlineStack>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                No quick replies yet. Add them on the Delivery Scheduler page.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      )}
    </Modal>
  );
}
