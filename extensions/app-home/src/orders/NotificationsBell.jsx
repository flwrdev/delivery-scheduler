import { REPLY_MODAL_ID, THREAD_MODAL_ID } from "./EmailModals";
import { EmailText, whenLabel } from "./email-parts";

export const BELL_POPOVER_ID = "orders-notifications-popover";

function ReplyRow({ item, when, onView, onReply, onSeen }) {
  return (
    <s-stack gap="small">
      <s-stack direction="inline" alignItems="center" gap="small">
        <s-icon type="email" tone="info" />
        <s-text type="strong">{`Customer replied to Order ${item.name}`}</s-text>
        {item.unseenCount > 1 && <s-badge>{`${item.unseenCount} new`}</s-badge>}
        {item.verdict === "fail" && <s-badge tone="warning">Unverified sender</s-badge>}
      </s-stack>
      <s-text color="subdued">
        {`${when} · ${item.fromName} <${item.fromAddress}>${
          item.matchedBy === "sender" ? " · matched by sender email" : ""
        }`}
      </s-text>
      <s-text type="strong">{item.subject}</s-text>
      <EmailText text={item.text} />
      <s-stack direction="inline" gap="small">
        <s-button variant="primary" commandFor={REPLY_MODAL_ID} command="--show" onClick={() => onReply(item)}>
          Reply
        </s-button>
        <s-button commandFor={THREAD_MODAL_ID} command="--show" onClick={() => onView(item)}>
          View conversation
        </s-button>
        <s-button variant="tertiary" href={`shopify://admin/orders/${item.legacyId}`} target="_blank">
          Open order
        </s-button>
        <s-button variant="tertiary" onClick={() => onSeen([item])}>
          Seen
        </s-button>
      </s-stack>
    </s-stack>
  );
}

function RescheduleRow({ item, when, onOpen, onSeen }) {
  return (
    <s-stack gap="small">
      <s-stack direction="inline" alignItems="center" gap="small">
        <s-icon type="calendar" tone="critical" />
        <s-text type="strong">{`Order ${item.name} rescheduled`}</s-text>
      </s-stack>
      <s-text>{`${item.from} → ${item.to}`}</s-text>
      <s-text color="subdued">{`${when}${item.customerName ? ` · ${item.customerName}` : ""}`}</s-text>
      <s-stack direction="inline" gap="small">
        <s-button onClick={() => onOpen(item)}>Open order</s-button>
        <s-button variant="tertiary" onClick={() => onSeen([item])}>
          Seen
        </s-button>
      </s-stack>
    </s-stack>
  );
}

/** Bell button with a popover of unseen customer replies and recent reschedules, newest first. */
export function NotificationsBell({
  replies,
  repliesLoading,
  repliesError,
  reschedules,
  pendingReplySeenIds,
  pendingRescheduleSeenIds,
  seenError,
  timezone,
  todayISO,
  onCheckInbox,
  onViewReply,
  onReply,
  onReplySeen,
  onOpenReschedule,
  onRescheduleSeen,
}) {
  const visibleReplies = replies.filter((r) => !pendingReplySeenIds.has(r.orderId));
  const visibleReschedules = reschedules.filter((r) => !pendingRescheduleSeenIds.has(r.orderId));
  const items = [
    ...visibleReplies.map((item) => ({ kind: "reply", at: Date.parse(item.receivedAt), item })),
    ...visibleReschedules.map((item) => ({
      kind: "reschedule",
      at: Date.parse(item.requestedAt),
      item,
    })),
  ].sort((a, b) => b.at - a.at);
  const count = items.length;

  return (
    <>
      <s-button
        icon="notification"
        commandFor={BELL_POPOVER_ID}
        accessibilityLabel={count > 0 ? `Notifications, ${count} unseen` : "Notifications"}
        onClick={onCheckInbox}
      >
        {count > 0 ? (count > 99 ? "99+" : String(count)) : ""}
      </s-button>
      <s-popover id={BELL_POPOVER_ID} inlineSize="480px" maxBlockSize="640px">
        <s-stack gap="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small">
            <s-stack direction="inline" alignItems="center" gap="small">
              <s-heading>Notifications</s-heading>
              {repliesLoading && <s-spinner accessibilityLabel="Checking the inbox" />}
            </s-stack>
            {count > 1 && (
              <s-button
                variant="tertiary"
                onClick={() => {
                  onReplySeen(visibleReplies);
                  onRescheduleSeen(visibleReschedules);
                }}
              >
                Mark all as seen
              </s-button>
            )}
          </s-stack>
          {repliesError && <s-text tone="critical">{repliesError}</s-text>}
          {seenError && <s-text tone="critical">{seenError}</s-text>}
          {count === 0 && !repliesLoading && <s-text color="subdued">You're all caught up.</s-text>}
          {items.map((entry, index) => (
            <s-stack key={`${entry.kind}-${entry.item.orderId}`} gap="base">
              {index > 0 && <s-divider />}
              {entry.kind === "reply" ? (
                <ReplyRow
                  item={entry.item}
                  when={whenLabel(entry.item.receivedAt, timezone, todayISO)}
                  onView={onViewReply}
                  onReply={onReply}
                  onSeen={onReplySeen}
                />
              ) : (
                <RescheduleRow
                  item={entry.item}
                  when={whenLabel(entry.item.requestedAt, timezone, todayISO)}
                  onOpen={onOpenReschedule}
                  onSeen={onRescheduleSeen}
                />
              )}
            </s-stack>
          ))}
        </s-stack>
      </s-popover>
    </>
  );
}
