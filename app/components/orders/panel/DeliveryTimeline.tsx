import type { ReactNode } from "react";
import { Badge, BlockStack, Divider, InlineStack, Text } from "@shopify/polaris";
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
  | { kind: "email"; timestamp: string; to: string };

function timeValue(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  // Pushes events with an unparseable/missing timestamp (the reschedule
  // history's "—" sentinel) to the bottom, matching the prior sort behavior.
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function buildActivityEvents(order: Order): ActivityEvent[] {
  const events: ActivityEvent[] = getRescheduleTimelineEvents(order).map(
    (event) => ({ kind: "reschedule", timestamp: event.requestedAt, event }),
  );

  const fulfilledAt = getFulfilledAt(order);
  if (fulfilledAt) events.push({ kind: "fulfilled", timestamp: fulfilledAt });

  const deliveredAt = getDeliveredAt(order);
  if (deliveredAt) events.push({ kind: "delivered", timestamp: deliveredAt });

  for (const { sentAt, to } of getEmailSentEvents(order)) {
    events.push({ kind: "email", timestamp: sentAt, to });
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
export function DeliveryTimeline({ order }: { order: Order }) {
  const events = getRescheduleTimelineEvents(order);
  const activityEvents = buildActivityEvents(order);
  const hasActivity =
    events.length > 0 || hasRescheduleTag(order) || activityEvents.length > 0;
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
