import { buildSchedulerOverview } from "../../../../app/lib/scheduler-overview";
import { formatDateLabel, useSchedulerOp } from "./use-scheduler-op";

function Stat({ label, value }) {
  return (
    <s-stack gap="small-300">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-stack>
  );
}

export function OverviewSection({ state, onSync, onSelectDate }) {
  const { rules, countsMeta, today } = state;
  const overview = buildSchedulerOverview(rules, today);
  const { submitOp, submitting } = useSchedulerOp({
    onSync,
    successMessage: () => "Live counts refreshed",
  });

  const countsCaption =
    (countsMeta.status === "ok" || countsMeta.status === "partial") && countsMeta.fetchedAt
      ? `${countsMeta.status === "partial" ? "Partial" : "Live"} counts ${
          countsMeta.fromCache ? "cached" : "refreshed"
        } ${new Date(countsMeta.fetchedAt).toLocaleTimeString()}`
      : countsMeta.status === "untracked"
        ? "No capacity-tracked dates yet"
        : null;

  return (
    <s-section heading="Overview">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="end" alignItems="center" gap="small">
          {countsCaption && <s-text color="subdued">{countsCaption}</s-text>}
          <s-button loading={submitting} onClick={() => submitOp("refreshCounts", {})}>
            Refresh counts
          </s-button>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
          <Stat label="Delivery slots" value={String(overview.slotCount)} />
          <Stat label="Blocked dates" value={String(overview.blockedDateCount)} />
          <Stat label="Capacity days" value={String(overview.trackedCapacityDayCount)} />
          <Stat
            label="At capacity"
            value={`${overview.fullCount} full / ${overview.nearLimitCount} near`}
          />
        </s-grid>

        {overview.watchlist.length > 0 && (
          <s-stack gap="small">
            <s-heading>Capacity watchlist</s-heading>
            {overview.watchlist.map((entry) => (
              <s-stack
                key={`${entry.date}-${entry.slotValue}`}
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-link onClick={() => onSelectDate(entry.date)}>
                  {`${formatDateLabel(entry.date)} · ${entry.slotValue}`}
                </s-link>
                <s-badge tone={entry.status.tone}>{entry.status.label}</s-badge>
                <s-text color="subdued">{`${entry.booked} of ${entry.capacity} booked (${entry.utilizationPercent}%)`}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
