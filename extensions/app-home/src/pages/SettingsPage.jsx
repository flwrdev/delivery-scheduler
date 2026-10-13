import { useCallback, useEffect, useState } from "preact/hooks";

import { loadSchedulerState } from "../scheduler-api";
import { DayOverridesSection } from "../settings/DayOverridesSection";
import { GeneralSection } from "../settings/GeneralSection";
import { OverviewSection } from "../settings/OverviewSection";
import { QuickRepliesSection } from "../settings/QuickRepliesSection";
import { SlotsSection } from "../settings/SlotsSection";

const COUNTS_CAP_LABELS = {
  dates: "more capacity-tracked dates than one scan covers",
  pages: "more orders on one date range than one scan pages through",
};
const MAX_LISTED_AFFECTED_DATES = 8;

function describeCountsCaps(truncation) {
  if (!truncation?.caps.length) {
    return null;
  }
  return truncation.caps.map((cap) => COUNTS_CAP_LABELS[cap]).join(" and ");
}

function describeAffectedDates(truncation) {
  const dates = truncation?.affectedDates ?? [];
  if (!dates.length) {
    return null;
  }
  const listed = dates.slice(0, MAX_LISTED_AFFECTED_DATES);
  const rest = dates.length - listed.length;
  return `${dates.length} date${dates.length === 1 ? "" : "s"} affected: ${listed.join(
    ", ",
  )}${rest > 0 ? `, +${rest} more` : ""}`;
}

export default function SettingsPage() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);

  useEffect(() => {
    let cancelled = false;
    shopify.loading(true);
    loadSchedulerState()
      .then((next) => !cancelled && setState(next))
      .catch((error) => {
        console.error("Failed to load schedule rules:", error);
        if (!cancelled) setLoadError("Schedule settings could not be loaded. Reload the page.");
      })
      .finally(() => shopify.loading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const onSync = useCallback((next) => setState(next), []);

  if (loadError) {
    return (
      <s-page heading="Delivery Scheduler">
        <s-banner tone="critical">{loadError}</s-banner>
      </s-page>
    );
  }

  if (!state) {
    return (
      <s-page heading="Delivery Scheduler">
        <s-spinner accessibilityLabel="Loading schedule settings" />
      </s-page>
    );
  }

  const countsCapsLabel = describeCountsCaps(state.countsMeta.truncation);
  const countsAffectedLabel = describeAffectedDates(state.countsMeta.truncation);

  const settingsKey = [
    state.rules.timezone,
    state.rules.cutoffHour,
    state.rules.prepHours,
    state.rules.maxDays,
  ].join("|");
  const slotsKey = JSON.stringify(state.rules.slots);
  const dayCapacityConfig = selectedDate
    ? Object.entries(state.rules.slotCapacity[selectedDate] ?? {}).map(([slotValue, entry]) => [
        slotValue,
        entry.capacity,
      ])
    : null;
  const dayKey = `${selectedDate ?? ""}|${JSON.stringify({
    blocked: selectedDate ? state.rules.disabledDates.includes(selectedDate) : null,
    slots: selectedDate ? state.rules.disabledSlots[selectedDate] : null,
    capacity: dayCapacityConfig,
  })}`;

  return (
    <s-page heading="Delivery Scheduler" inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/">
        Orders
      </s-link>
      <s-stack gap="base">
        {state.configHealth.length > 0 && (
          <s-banner tone="critical" heading="Stored settings need attention">
            {state.configHealth.map((issue) => (
              <s-paragraph key={`${issue.column}-${issue.message}`}>
                {issue.column}: {issue.message}
              </s-paragraph>
            ))}
          </s-banner>
        )}
        {state.countsMeta.status === "error" && (
          <s-banner tone="warning" heading="Live booked counts are unavailable">
            Capacity limits are not being checked against live orders right now. Counts will
            recover automatically — or press “Refresh counts”.
          </s-banner>
        )}
        {state.countsMeta.status === "partial" && (
          <s-banner tone="warning" heading="Live booked counts are incomplete">
            <s-paragraph>
              {`The order scan hit a limit${
                countsCapsLabel ? ` (${countsCapsLabel})` : ""
              }, so booked counts are a lower bound right now — a window that is already full can still show as open, and checkouts into it are not being blocked.`}
            </s-paragraph>
            {countsAffectedLabel && <s-paragraph>{countsAffectedLabel}</s-paragraph>}
          </s-banner>
        )}

        <OverviewSection state={state} onSync={onSync} onSelectDate={setSelectedDate} />
        <GeneralSection key={settingsKey} state={state} onSync={onSync} />
        <SlotsSection key={slotsKey} state={state} onSync={onSync} />
        <DayOverridesSection
          key={dayKey}
          state={state}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          onSync={onSync}
        />
        <QuickRepliesSection />
      </s-stack>
    </s-page>
  );
}
