import { useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Divider,
  Icon,
  InlineStack,
  Popover,
  Spinner,
  Text,
} from "@shopify/polaris";
import { CalendarIcon, ChatIcon, NotificationIcon } from "@shopify/polaris-icons";
import { getShopLocalDate } from "../../lib/delivery-availability";
import type { EmailReplyNotification } from "../../lib/email-replies";
import {
  type RecentRescheduleItem,
  formatShopLocalTime,
  formatShortMonthDay,
  shiftISODate,
} from "../../lib/recent-reschedules";

export interface NotificationsBellProps {
  replies: EmailReplyNotification[];
  repliesLoading: boolean;
  repliesError: string | null;
  reschedules: RecentRescheduleItem[];
  /** Hidden while Seen is in flight so a clicked row doesn't linger for the round trip. */
  pendingReplySeenIds: ReadonlySet<string>;
  pendingRescheduleSeenIds: ReadonlySet<string>;
  seenErrorMessage?: string | null;
  timezone: string;
  todayISO: string;
  onOpen: () => void;
  onOpenReply: (item: EmailReplyNotification) => void;
  onReplySeen: (items: EmailReplyNotification[]) => void;
  onOpenReschedule: (item: RecentRescheduleItem) => void;
  onRescheduleSeen: (items: RecentRescheduleItem[]) => void;
}

type BellItem =
  | { kind: "reply"; at: number; item: EmailReplyNotification }
  | { kind: "reschedule"; at: number; item: RecentRescheduleItem };

function whenLabel(iso: string, timezone: string, todayISO: string): string {
  const time = formatShopLocalTime(iso, timezone);
  const day = getShopLocalDate(timezone, new Date(iso));
  if (day === todayISO) return time;
  if (day === shiftISODate(todayISO, -1)) return `Yesterday · ${time}`;
  return `${formatShortMonthDay(day)} · ${time}`;
}

export function NotificationsBell({
  replies,
  repliesLoading,
  repliesError,
  reschedules,
  pendingReplySeenIds,
  pendingRescheduleSeenIds,
  seenErrorMessage,
  timezone,
  todayISO,
  onOpen,
  onOpenReply,
  onReplySeen,
  onOpenReschedule,
  onRescheduleSeen,
}: NotificationsBellProps) {
  const [active, setActive] = useState(false);

  const visibleReplies = replies.filter((r) => !pendingReplySeenIds.has(r.orderId));
  const visibleReschedules = reschedules.filter(
    (r) => !pendingRescheduleSeenIds.has(r.orderId),
  );
  const items: BellItem[] = [
    ...visibleReplies.map(
      (item): BellItem => ({ kind: "reply", at: Date.parse(item.receivedAt), item }),
    ),
    ...visibleReschedules.map(
      (item): BellItem => ({
        kind: "reschedule",
        at: Date.parse(item.requestedAt),
        item,
      }),
    ),
  ].sort((a, b) => b.at - a.at);
  const count = items.length;

  const toggle = () => {
    if (!active) onOpen();
    setActive((v) => !v);
  };
  const close = () => setActive(false);

  const activator = (
    <span className="orders-bell">
      <Button
        variant="tertiary"
        icon={NotificationIcon}
        onClick={toggle}
        accessibilityLabel={
          count > 0 ? `Notifications, ${count} unseen` : "Notifications"
        }
        disclosure={false}
      />
      {count > 0 && (
        <span className="orders-bell-count" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </span>
  );

  return (
    <Popover
      active={active}
      activator={activator}
      onClose={close}
      preferredAlignment="right"
      fluidContent
    >
      <Box padding="300" minWidth="340px" maxWidth="420px">
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingSm">
              Notifications
            </Text>
            {count > 1 && (
              <Button
                variant="plain"
                onClick={() => {
                  onReplySeen(visibleReplies);
                  onRescheduleSeen(visibleReschedules);
                }}
              >
                Mark all as seen
              </Button>
            )}
          </InlineStack>
          {repliesLoading && (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" accessibilityLabel="Checking the inbox" />
              <Text as="span" variant="bodySm" tone="subdued">
                Checking the inbox…
              </Text>
            </InlineStack>
          )}
          {repliesError && (
            <Text as="p" variant="bodySm" tone="critical">
              {repliesError}
            </Text>
          )}
          {seenErrorMessage && (
            <Text as="p" variant="bodySm" tone="critical">
              {seenErrorMessage}
            </Text>
          )}
          {count === 0 && !repliesLoading && (
            <Text as="p" tone="subdued">
              You're all caught up.
            </Text>
          )}
          {count > 0 && (
            <div className="orders-bell-list">
              <BlockStack gap="200">
                {items.map((entry, index) => (
                  <BlockStack gap="200" key={`${entry.kind}-${entry.item.orderId}`}>
                    {index > 0 && <Divider />}
                    {entry.kind === "reply" ? (
                      <ReplyRow
                        item={entry.item}
                        when={whenLabel(entry.item.receivedAt, timezone, todayISO)}
                        onOpen={() => {
                          close();
                          onOpenReply(entry.item);
                        }}
                        onSeen={() => onReplySeen([entry.item])}
                      />
                    ) : (
                      <RescheduleRow
                        item={entry.item}
                        when={whenLabel(entry.item.requestedAt, timezone, todayISO)}
                        onOpen={() => {
                          close();
                          onOpenReschedule(entry.item);
                        }}
                        onSeen={() => onRescheduleSeen([entry.item])}
                      />
                    )}
                  </BlockStack>
                ))}
              </BlockStack>
            </div>
          )}
        </BlockStack>
      </Box>
    </Popover>
  );
}

function RowActions({ onOpen, onSeen }: { onOpen: () => void; onSeen: () => void }) {
  return (
    <InlineStack gap="200">
      <Button size="slim" onClick={onOpen}>
        Open order
      </Button>
      <Button size="slim" variant="plain" onClick={onSeen}>
        Seen
      </Button>
    </InlineStack>
  );
}

function ReplyRow({
  item,
  when,
  onOpen,
  onSeen,
}: {
  item: EmailReplyNotification;
  when: string;
  onOpen: () => void;
  onSeen: () => void;
}) {
  return (
    <InlineStack gap="300" wrap={false} blockAlign="start">
      <Box>
        <Icon source={ChatIcon} tone="info" />
      </Box>
      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" fontWeight="semibold">
            Customer replied to Order {item.name}
          </Text>
          {item.unseenCount > 1 && (
            <Badge size="small">{`${item.unseenCount} new`}</Badge>
          )}
          {item.verdict === "fail" && (
            <Badge size="small" tone="warning">
              Unverified sender
            </Badge>
          )}
        </InlineStack>
        {item.preview && <Text as="p">“{item.preview}”</Text>}
        <Text as="p" variant="bodySm" tone="subdued">
          {when} · {item.fromName}
          {item.matchedBy === "sender" ? " · matched by sender email" : ""}
        </Text>
        <RowActions onOpen={onOpen} onSeen={onSeen} />
      </BlockStack>
    </InlineStack>
  );
}

function RescheduleRow({
  item,
  when,
  onOpen,
  onSeen,
}: {
  item: RecentRescheduleItem;
  when: string;
  onOpen: () => void;
  onSeen: () => void;
}) {
  return (
    <InlineStack gap="300" wrap={false} blockAlign="start">
      <Box>
        <Icon source={CalendarIcon} tone="critical" />
      </Box>
      <BlockStack gap="100">
        <Text as="span" fontWeight="semibold">
          Order {item.name} rescheduled
        </Text>
        <Text as="p">New date: {item.to}</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {when}
          {item.customerName ? ` · ${item.customerName}` : ""}
        </Text>
        <RowActions onOpen={onOpen} onSeen={onSeen} />
      </BlockStack>
    </InlineStack>
  );
}
