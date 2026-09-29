import { type ReactNode, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Divider,
  InlineStack,
  Text,
} from "@shopify/polaris";
import type { MailboxMessage } from "../../../lib/email-replies";
import type { EmailThreadData } from "../../../routes/app.orders_.email-thread";
import {
  type Order,
  type RescheduleTimelineEvent,
  getAttr,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getRescheduleTimelineEvents,
  hasRescheduleTag,
  getFulfilledAt,
  getDeliveredAt,
  getEmailSentEvents,
  formatTimelineDelivery,
  formatTimelineTime,
  formatTimelineStatus,
} from "../../../lib/order-utils";

// Puts the time in its own right-aligned column instead of inline with the
// label/status text — mirrors Shopify's native order-activity timeline,
// where the clock time sits apart from the event copy (not stacked into
// it). Deliberately clock-time-only (no date) and kept visually quiet
// (bodyXs + subdued) so it reads as a light annotation, not a headline.
function TimelineRow({
  time,
  children,
}: {
  time: string;
  children: ReactNode;
}) {
  return (
    <InlineStack align="space-between" blockAlign="start" wrap={false} gap="200">
      <BlockStack gap="050">{children}</BlockStack>
      <span className="odp-timeline-time">
        <Text as="span" variant="bodyXs" tone="subdued">
          {time}
        </Text>
      </span>
    </InlineStack>
  );
}

function sourceLabel(source: string): string | null {
  const s = source.trim().toLowerCase();
  if (s === "customer") return "Customer";
  if (s === "merchant") return "Merchant";
  return null;
}

type ActivityEvent =
  | { kind: "reschedule"; timestamp: string; event: RescheduleTimelineEvent }
  | { kind: "fulfilled"; timestamp: string }
  | { kind: "delivered"; timestamp: string }
  | { kind: "email"; timestamp: string; to: string }
  | { kind: "mail"; timestamp: string; message: MailboxMessage };

const EMAIL_LOG_MATCH_WINDOW_MS = 2 * 60 * 1000;
const COLLAPSED_TEXT_LENGTH = 280;

function timeValue(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  // Pushes events with an unparseable/missing timestamp (the reschedule
  // history's "—" sentinel) to the bottom, matching the prior sort behavior.
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

// An app send exists twice: as an EmailSendLog row and as its BCC copy in
// INBOX. The mailbox copy carries the subject and text, so the log row is the
// one dropped. The two-minute window absorbs SMTP delivery delay.
function isCoveredByMailbox(
  sentAt: string,
  to: string,
  mailbox: ReadonlyArray<MailboxMessage>,
): boolean {
  const ts = Date.parse(sentAt);
  if (Number.isNaN(ts)) return false;
  const recipient = to.trim().toLowerCase();
  return mailbox.some(
    (m) =>
      m.direction === "outbound" &&
      m.toAddresses.includes(recipient) &&
      Math.abs(Date.parse(m.date) - ts) <= EMAIL_LOG_MATCH_WINDOW_MS,
  );
}

function buildActivityEvents(
  order: Order,
  mailbox: ReadonlyArray<MailboxMessage>,
): ActivityEvent[] {
  const events: ActivityEvent[] = getRescheduleTimelineEvents(order).map(
    (event) => ({ kind: "reschedule", timestamp: event.requestedAt, event }),
  );

  const fulfilledAt = getFulfilledAt(order);
  if (fulfilledAt) events.push({ kind: "fulfilled", timestamp: fulfilledAt });

  const deliveredAt = getDeliveredAt(order);
  if (deliveredAt) events.push({ kind: "delivered", timestamp: deliveredAt });

  for (const { sentAt, to } of getEmailSentEvents(order)) {
    if (isCoveredByMailbox(sentAt, to, mailbox)) continue;
    events.push({ kind: "email", timestamp: sentAt, to });
  }

  for (const message of mailbox) {
    events.push({ kind: "mail", timestamp: message.date, message });
  }

  return events.sort(
    (a, b) => timeValue(b.timestamp) - timeValue(a.timestamp),
  );
}

/**
 * At-a-glance reschedule history: original schedule (order-time
 * customAttributes), each recorded change (from → to, who, when), and the
 * current/approved schedule (canonical custom.* metafields). Rendered at the
 * bottom of the panel, below Tags. Renders nothing (including its own
 * leading divider) when the order has no reschedule signal.
 */
function MailItem({
  message,
  onReply,
}: {
  message: MailboxMessage;
  onReply?: (message: MailboxMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inbound = message.direction === "inbound";
  const long = message.text.length > COLLAPSED_TEXT_LENGTH;
  const shown =
    long && !expanded
      ? `${message.text.slice(0, COLLAPSED_TEXT_LENGTH).trimEnd()}…`
      : message.text;
  return (
    <TimelineRow time={formatTimelineTime(message.date)}>
      <Text as="span" variant="bodySm" tone="subdued">
        {inbound ? "Customer replied" : `Email sent to ${message.toAddresses.join(", ")}`}
        {inbound && message.verdict === "fail" && (
          <>
            {" · "}
            <Badge size="small" tone="warning">
              Unverified sender
            </Badge>
          </>
        )}
      </Text>
      <Text as="span" fontWeight="medium">
        {message.subject}
      </Text>
      {shown && (
        <span className="odp-timeline-mail-text">
          <Text as="span" variant="bodySm">
            {shown}
          </Text>
        </span>
      )}
      <InlineStack gap="200">
        {long && (
          <Button variant="plain" size="slim" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </Button>
        )}
        {inbound && onReply && (
          <Button variant="plain" size="slim" onClick={() => onReply(message)}>
            Reply to customer
          </Button>
        )}
      </InlineStack>
    </TimelineRow>
  );
}

export interface DeliveryTimelineProps {
  order: Order;
  onReplyEmail?: (message: MailboxMessage) => void;
}

export function DeliveryTimeline({ order, onReplyEmail }: DeliveryTimelineProps) {
  const threadFetcher = useFetcher<EmailThreadData>();
  const threadUrl = `/app/orders/email-thread?orderId=${encodeURIComponent(order.id)}`;
  const loadThread = threadFetcher.load;
  // Each load is an IMAP login, so a new `load` identity alone must not refetch.
  const loadedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedUrlRef.current === threadUrl) return;
    loadedUrlRef.current = threadUrl;
    loadThread(threadUrl);
  }, [threadUrl, loadThread]);
  // Right after switching orders the fetcher still holds the previous order's thread.
  const threadData =
    threadFetcher.data && threadFetcher.data.orderId === order.id
      ? threadFetcher.data
      : null;
  const mailbox = threadData?.ok ? threadData.messages : [];
  const threadLoading = threadFetcher.state !== "idle" && !threadData;
  const threadError = threadData && !threadData.ok ? threadData.error : null;

  const events = getRescheduleTimelineEvents(order);
  const activityEvents = buildActivityEvents(order, mailbox);
  const hasActivity =
    events.length > 0 ||
    hasRescheduleTag(order) ||
    activityEvents.length > 0 ||
    threadLoading ||
    threadError !== null;
  if (!hasActivity) return null;

  const attrs = order.customAttributes || [];
  // The reschedule write path overwrites the Delivery Date/Time
  // customAttributes as a legacy mirror, so once an order has been
  // rescheduled the attributes no longer hold the ORIGINAL schedule — the
  // oldest history event's `from` does (events sort newest-first). The
  // attributes stay as the fallback for history-less orders.
  const oldestEvent = events.length > 0 ? events[events.length - 1] : null;
  const originalFromHistory = oldestEvent
    ? formatTimelineDelivery(oldestEvent.fromDate, oldestEvent.fromTimeSlot)
    : "—";
  const originalDelivery =
    originalFromHistory !== "—"
      ? originalFromHistory
      : formatTimelineDelivery(
          getAttr(attrs, "Delivery Date"),
          getAttr(attrs, "Delivery Time"),
        );
  const currentDelivery = formatTimelineDelivery(
    getDeliveryDateValue(order),
    getDeliveryTimeValue(order),
  );
  const currentStatus = order.rescheduleStatus?.value?.trim() || "";
  // Skip the redundant "Original schedule" row when it's identical to
  // "Current schedule" (order was never actually rescheduled) — showing the
  // same date/slot twice reads as confusing duplication, not information.
  const showOriginalSchedule = originalDelivery !== currentDelivery;

  return (
    <>
      <Divider />
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Delivery timeline
        </Text>
        {threadLoading && (
          <Text as="p" variant="bodySm" tone="subdued">
            Checking the inbox for emails about this order…
          </Text>
        )}
        {threadError && (
          <Text as="p" variant="bodySm" tone="subdued">
            Emails not shown: {threadError}
          </Text>
        )}
        <ul className="odp-timeline">
          <li className="odp-timeline-item odp-timeline-item--current">
            <BlockStack gap="050">
              <Text as="span" variant="bodySm" tone="subdued">
                Current schedule{currentStatus ? ` · ${currentStatus}` : ""}
              </Text>
              <Text as="span" fontWeight="medium">
                {currentDelivery}
              </Text>
            </BlockStack>
          </li>
          {hasRescheduleTag(order) && events.length === 0 && (
            <li className="odp-timeline-item">
              <Text as="span" tone="subdued">
                Rescheduled — history not yet recorded
              </Text>
            </li>
          )}
          {activityEvents.map((item, index) => {
            if (item.kind === "reschedule") {
              const rescheduleIndex = activityEvents
                .slice(0, index)
                .filter((e) => e.kind === "reschedule").length;
              const event = item.event;
              const from = formatTimelineDelivery(
                event.fromDate,
                event.fromTimeSlot,
              );
              const to = formatTimelineDelivery(event.date, event.timeSlot);
              const source = sourceLabel(event.source);
              return (
                <li
                  className="odp-timeline-item"
                  key={`reschedule-${event.requestedAt}-${event.date}-${event.timeSlot}-${index}`}
                >
                  <TimelineRow time={formatTimelineTime(event.requestedAt)}>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {rescheduleIndex === 0
                        ? "Latest reschedule"
                        : `Reschedule ${events.length - rescheduleIndex}`}
                      {source ? " · " : ""}
                      {source && (
                        <Badge size="small" tone={source === "Merchant" ? "info" : undefined}>
                          {source}
                        </Badge>
                      )}
                    </Text>
                    <Text as="span">
                      {from !== "—" ? `${from} → ${to}` : to}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {formatTimelineStatus(event.status)}
                    </Text>
                  </TimelineRow>
                </li>
              );
            }
            if (item.kind === "fulfilled") {
              return (
                <li className="odp-timeline-item" key={`fulfilled-${item.timestamp}`}>
                  <TimelineRow time={formatTimelineTime(item.timestamp)}>
                    <Text as="span">Marked fulfilled</Text>
                  </TimelineRow>
                </li>
              );
            }
            if (item.kind === "mail") {
              return (
                <li
                  className={`odp-timeline-item${
                    item.message.direction === "inbound"
                      ? " odp-timeline-item--reply"
                      : ""
                  }`}
                  key={`mail-${item.message.key}`}
                >
                  <MailItem message={item.message} onReply={onReplyEmail} />
                </li>
              );
            }
            if (item.kind === "delivered") {
              return (
                <li className="odp-timeline-item" key={`delivered-${item.timestamp}`}>
                  <TimelineRow time={formatTimelineTime(item.timestamp)}>
                    <Text as="span">Delivered</Text>
                  </TimelineRow>
                </li>
              );
            }
            return (
              <li
                className="odp-timeline-item"
                key={`email-${item.timestamp}-${item.to}`}
              >
                <TimelineRow time={formatTimelineTime(item.timestamp)}>
                  <Text as="span">Email sent to {item.to}</Text>
                </TimelineRow>
              </li>
            );
          })}
          {showOriginalSchedule && (
            <li className="odp-timeline-item">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Original schedule
                </Text>
                <Text as="span">{originalDelivery}</Text>
              </BlockStack>
            </li>
          )}
        </ul>
      </BlockStack>
    </>
  );
}
