import { recentReschedulesTitle } from "../../../../app/lib/recent-reschedules";

const MAX_ROWS = 5;

function sourceLabel(source) {
  const s = source.trim().toLowerCase();
  if (s === "customer") return "Customer";
  if (s === "merchant") return "Merchant";
  return source;
}

/** Recent reschedules not yet marked seen, on every tab. */
export function RecentReschedules({ items, pendingSeenIds, errorMessage, onOpen, onSeen, onSeenAll }) {
  const visible = items.filter((item) => !pendingSeenIds.has(item.orderId));
  if (visible.length === 0) return null;
  const rows = visible.slice(0, MAX_ROWS);

  return (
    <s-banner tone="info" heading={recentReschedulesTitle(visible)}>
      <s-stack gap="small">
        {rows.map((item) => (
          <s-stack
            key={`${item.orderId}-${item.requestedAt}`}
            direction="inline"
            gap="base"
            alignItems="center"
          >
            <s-text type="strong">{item.name}</s-text>
            <s-text>{item.customerName}</s-text>
            <s-text>{`${item.from} → ${item.to}`}</s-text>
            <s-text color="subdued">
              {`${item.dayLabel === "Today" ? item.timeLabel : `${item.dayLabel} · ${item.timeLabel}`} · ${sourceLabel(item.source)}`}
            </s-text>
            <s-button onClick={() => onOpen(item)}>Open</s-button>
            <s-button variant="tertiary" onClick={() => onSeen(item)}>
              Seen
            </s-button>
          </s-stack>
        ))}
        {visible.length > rows.length && (
          <s-text color="subdued">
            {`+${visible.length - rows.length} more — mark the rows above as seen to reveal them, or use the Mark all button.`}
          </s-text>
        )}
        {errorMessage && <s-text tone="critical">{errorMessage}</s-text>}
      </s-stack>
      {visible.length > 1 && (
        <s-button slot="secondary-actions" onClick={() => onSeenAll(visible)}>
          {`Mark all ${visible.length} as seen`}
        </s-button>
      )}
    </s-banner>
  );
}
