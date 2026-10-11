import { Banner, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import {
  type RecentRescheduleItem,
  recentReschedulesTitle,
} from "../../lib/recent-reschedules";

// Renders on every tab — the whole point is that the rescheduled order is no
// longer in the view the merchant is looking at.
const MAX_ROWS = 5;

export interface RecentReschedulesBannerProps {
  items: RecentRescheduleItem[];
  /** Order ids whose Seen click is still in flight — hidden optimistically. */
  pendingSeenIds: ReadonlySet<string>;
  errorMessage?: string | null;
  onOpen: (item: RecentRescheduleItem) => void;
  onSeen: (item: RecentRescheduleItem) => void;
  /** Mark every visible row seen in one op (a bulk merchant reschedule can list dozens). */
  onSeenAll: (items: RecentRescheduleItem[]) => void;
}

function sourceLabel(source: string): string {
  const s = source.trim().toLowerCase();
  if (s === "customer") return "Customer";
  if (s === "merchant") return "Merchant";
  return source;
}

export function RecentReschedulesBanner({
  items,
  pendingSeenIds,
  errorMessage,
  onOpen,
  onSeen,
  onSeenAll,
}: RecentReschedulesBannerProps) {
  const visible = items.filter((item) => !pendingSeenIds.has(item.orderId));
  if (visible.length === 0) return null;
  const rows = visible.slice(0, MAX_ROWS);

  return (
    <Banner
      tone="info"
      title={recentReschedulesTitle(visible)}
      action={
        visible.length > 1
          ? {
              content: `Mark all ${visible.length} as seen`,
              onAction: () => onSeenAll(visible),
            }
          : undefined
      }
    >
      <BlockStack gap="200">
        {rows.map((item) => (
          <InlineStack
            key={`${item.orderId}-${item.requestedAt}`}
            gap="300"
            blockAlign="center"
            wrap
          >
            <Text as="span" fontWeight="semibold">
              {item.name}
            </Text>
            <Text as="span">{item.customerName}</Text>
            <Text as="span">
              {item.from} → {item.to}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {item.dayLabel === "Today"
                ? item.timeLabel
                : `${item.dayLabel} · ${item.timeLabel}`}
              {" · "}
              {sourceLabel(item.source)}
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <Button size="slim" onClick={() => onOpen(item)}>
                Open
              </Button>
              <Button size="slim" variant="plain" onClick={() => onSeen(item)}>
                Seen
              </Button>
            </InlineStack>
          </InlineStack>
        ))}
        {visible.length > rows.length && (
          <Text as="p" tone="subdued" variant="bodySm">
            {visible.length - rows.length} more. Mark rows as seen to show
            them.
          </Text>
        )}
        {errorMessage && (
          <Text as="p" tone="critical" variant="bodySm">
            {errorMessage}
          </Text>
        )}
      </BlockStack>
    </Banner>
  );
}
