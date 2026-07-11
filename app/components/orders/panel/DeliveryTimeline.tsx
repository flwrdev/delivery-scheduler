import { Badge, BlockStack, Text } from "@shopify/polaris";
import {
  type Order,
  getAttr,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getRescheduleTimelineEvents,
  hasRescheduleTag,
  formatTimelineDelivery,
  formatTimelineTimestamp,
  formatTimelineStatus,
} from "../../../lib/order-utils";

function sourceLabel(source: string): string | null {
  const s = source.trim().toLowerCase();
  if (s === "customer") return "Customer";
  if (s === "merchant") return "Merchant";
  return null;
}

/**
 * At-a-glance reschedule history: original schedule (order-time
 * customAttributes), each recorded change (from → to, who, when), and the
 * current/approved schedule (canonical custom.* metafields). Renders nothing
 * when the order has no reschedule signal.
 */
export function DeliveryTimeline({ order }: { order: Order }) {
  const events = getRescheduleTimelineEvents(order);
  if (events.length === 0 && !hasRescheduleTag(order)) return null;

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

  return (
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
        {events.length === 0 ? (
          <li className="odp-timeline-item">
            <Text as="span" tone="subdued">
              Rescheduled — history not yet recorded
            </Text>
          </li>
        ) : (
          events.map((event, index) => {
            const from = formatTimelineDelivery(
              event.fromDate,
              event.fromTimeSlot,
            );
            const to = formatTimelineDelivery(event.date, event.timeSlot);
            const source = sourceLabel(event.source);
            return (
              <li
                className="odp-timeline-item"
                key={`${event.requestedAt}-${event.date}-${event.timeSlot}-${index}`}
              >
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {index === 0
                      ? "Latest reschedule"
                      : `Reschedule ${events.length - index}`}
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
                    {formatTimelineTimestamp(event.requestedAt)} ·{" "}
                    {formatTimelineStatus(event.status)}
                  </Text>
                </BlockStack>
              </li>
            );
          })
        )}
        <li className="odp-timeline-item">
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">
              Original schedule
            </Text>
            <Text as="span">{originalDelivery}</Text>
          </BlockStack>
        </li>
      </ul>
    </BlockStack>
  );
}
