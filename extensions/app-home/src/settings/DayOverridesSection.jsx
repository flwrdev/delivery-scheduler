import { useState } from "preact/hooks";

import { buildUpcomingOverrides } from "../../../../app/lib/scheduler-overview";
import { formatDateLabel, useSchedulerOp } from "./use-scheduler-op";

export function buildDayDraft(state, date) {
  const capacities = {};
  for (const [slotValue, entry] of Object.entries(state.rules.slotCapacity[date] ?? {})) {
    capacities[slotValue] = String(entry.capacity);
  }
  return {
    blocked: state.rules.disabledDates.includes(date),
    blockedSlots: [...(state.rules.disabledSlots[date] ?? [])],
    capacities,
  };
}

export function DayOverridesSection({ state, selectedDate, onSelectDate, onSync }) {
  const { rules, version, today } = state;
  const [draft, setDraft] = useState(() =>
    selectedDate ? buildDayDraft(state, selectedDate) : null,
  );

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) => (op === "clearDayOverride" ? "Overrides cleared" : "Day saved"),
  });

  const upcoming = buildUpcomingOverrides(rules, today);

  function selectDate(date) {
    onSelectDate(date);
    setDraft(date ? buildDayDraft(state, date) : null);
  }

  const hasStoredOverride =
    selectedDate !== null &&
    (rules.disabledDates.includes(selectedDate) ||
      selectedDate in rules.disabledSlots ||
      selectedDate in rules.slotCapacity);

  function saveDay() {
    const capacities = {};
    for (const [slotValue, raw] of Object.entries(draft.capacities)) {
      const trimmed = raw.trim();
      capacities[slotValue] = trimmed === "" ? null : Number(trimmed);
    }
    submitOp("saveDayOverride", {
      version,
      date: selectedDate,
      blocked: draft.blocked,
      blockedSlots: draft.blockedSlots,
      capacities,
    });
  }

  return (
    <s-section heading="Date overrides">
      <s-stack gap="base">
        <s-text color="subdued">
          Block a whole day, close individual windows, or cap how many orders a window can take
          on one date.
        </s-text>

        <s-date-field
          label="Pick a date"
          value={selectedDate ?? ""}
          error={fieldErrors.date}
          onChange={(event) => selectDate(event.currentTarget.value || null)}
        />

        {selectedDate && draft && (
          <s-stack gap="base">
            <s-divider />
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-heading>{formatDateLabel(selectedDate)}</s-heading>
              {selectedDate < today && <s-badge tone="warning">Past date</s-badge>}
            </s-stack>

            <s-checkbox
              label="Block the entire day"
              checked={draft.blocked}
              details="Customers can’t pick this date at all."
              onChange={(event) => {
                const blocked = event.currentTarget.checked;
                setDraft((d) => (d ? { ...d, blocked } : d));
              }}
            />

            {!draft.blocked && (
              <s-stack gap="base">
                {rules.slots.map((slot) => {
                  const blocked = draft.blockedSlots.includes(slot.value);
                  const liveBooked = rules.slotCapacity[selectedDate]?.[slot.value]?.booked;
                  return (
                    <s-stack key={slot.value} direction="inline" gap="base" alignItems="center">
                      <s-checkbox
                        label={`${slot.display} (${slot.value})`}
                        checked={blocked}
                        details={blocked ? "Blocked on this date" : undefined}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setDraft((d) =>
                            d
                              ? {
                                  ...d,
                                  blockedSlots: checked
                                    ? [...d.blockedSlots, slot.value]
                                    : d.blockedSlots.filter((value) => value !== slot.value),
                                }
                              : d,
                          );
                        }}
                      />
                      {!blocked && (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-number-field
                            label={`Capacity for ${slot.display}`}
                            labelAccessibilityVisibility="exclusive"
                            min={0}
                            placeholder="No cap"
                            value={draft.capacities[slot.value] ?? ""}
                            onInput={(event) => {
                              const value = event.currentTarget.value;
                              setDraft((d) =>
                                d
                                  ? { ...d, capacities: { ...d.capacities, [slot.value]: value } }
                                  : d,
                              );
                            }}
                          />
                          {typeof liveBooked === "number" && (
                            <s-text color="subdued">{liveBooked} booked</s-text>
                          )}
                        </s-stack>
                      )}
                    </s-stack>
                  );
                })}
                {fieldErrors.capacities && <s-text tone="critical">{fieldErrors.capacities}</s-text>}
                {fieldErrors.blockedSlots && (
                  <s-text tone="critical">{fieldErrors.blockedSlots}</s-text>
                )}
              </s-stack>
            )}

            <s-stack direction="inline" gap="small">
              <s-button variant="primary" loading={submitting} onClick={saveDay}>
                Save day
              </s-button>
              {hasStoredOverride && (
                <s-button
                  tone="critical"
                  loading={submitting}
                  onClick={() => submitOp("clearDayOverride", { version, date: selectedDate })}
                >
                  Clear overrides
                </s-button>
              )}
              <s-button onClick={() => selectDate(null)}>Close</s-button>
            </s-stack>
          </s-stack>
        )}

        {upcoming.length > 0 && (
          <s-stack gap="small">
            <s-divider />
            <s-heading>Upcoming overrides</s-heading>
            {upcoming.map((entry) => (
              <s-stack key={entry.date} direction="inline" gap="small" alignItems="center">
                <s-link onClick={() => selectDate(entry.date)}>{formatDateLabel(entry.date)}</s-link>
                {entry.blocked && <s-badge tone="critical">Blocked</s-badge>}
                {entry.blockedSlots.map((slotValue) => (
                  <s-badge key={slotValue} tone="warning">{`${slotValue} blocked`}</s-badge>
                ))}
                {entry.capacities.map(({ slotValue, capacity, booked }) => (
                  <s-badge key={slotValue} tone={booked >= capacity ? "critical" : "info"}>
                    {`${slotValue}: ${booked}/${capacity}`}
                  </s-badge>
                ))}
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
