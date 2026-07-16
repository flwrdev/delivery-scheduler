import { useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Text,
  TextField,
} from "@shopify/polaris";

import { buildUpcomingOverrides } from "../../lib/scheduler-overview";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

export interface DayDraft {
  blocked: boolean;
  blockedSlots: string[];
  capacities: Record<string, string>;
}

export function buildDayDraft(
  state: SchedulerPageState,
  date: string,
): DayDraft {
  const capacities: Record<string, string> = {};
  for (const [slotValue, entry] of Object.entries(
    state.rules.slotCapacity[date] ?? {},
  )) {
    capacities[slotValue] = String(entry.capacity);
  }
  return {
    blocked: state.rules.disabledDates.includes(date),
    blockedSlots: [...(state.rules.disabledSlots[date] ?? [])],
    capacities,
  };
}

export function DayOverridesCard({
  state,
  selectedDate,
  onSelectDate,
  onSync,
}: {
  state: SchedulerPageState;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  onSync: (state: SchedulerPageState) => void;
}) {
  const { rules, version, today } = state;
  const [draft, setDraft] = useState<DayDraft | null>(() =>
    selectedDate ? buildDayDraft(state, selectedDate) : null,
  );

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) =>
      op === "clearDayOverride" ? "Overrides cleared" : "Day saved",
  });

  const upcoming = buildUpcomingOverrides(rules, today);

  function selectDate(date: string | null) {
    onSelectDate(date);
    setDraft(date ? buildDayDraft(state, date) : null);
  }

  const hasStoredOverride =
    selectedDate !== null &&
    (rules.disabledDates.includes(selectedDate) ||
      selectedDate in rules.disabledSlots ||
      selectedDate in rules.slotCapacity);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Date overrides
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Block a whole day, close individual windows, or cap how many orders
            a window can take on one date.
          </Text>
        </BlockStack>

        <TextField
          label="Pick a date"
          type="date"
          autoComplete="off"
          min={today}
          value={selectedDate ?? ""}
          onChange={(date) => selectDate(date || null)}
          error={fieldErrors.date}
        />

        {selectedDate && draft && (
          <BlockStack gap="300">
            <Divider />
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingSm">
                {formatDateLabel(selectedDate)}
              </Text>
              {selectedDate < today && (
                <Badge tone="warning">Past date</Badge>
              )}
            </InlineStack>

            <Checkbox
              label="Block the entire day"
              checked={draft.blocked}
              onChange={(blocked) =>
                setDraft((d) => (d ? { ...d, blocked } : d))
              }
              helpText="Customers can’t pick this date at all."
            />

            {!draft.blocked && (
              <BlockStack gap="300">
                {rules.slots.map((slot) => {
                  const blocked = draft.blockedSlots.includes(slot.value);
                  const liveBooked =
                    rules.slotCapacity[selectedDate]?.[slot.value]?.booked;
                  return (
                    <InlineStack
                      key={slot.value}
                      gap="300"
                      blockAlign="center"
                      wrap
                    >
                      <div style={{ minWidth: "160px", flexGrow: 1 }}>
                        <Checkbox
                          label={`${slot.display} (${slot.value})`}
                          checked={blocked}
                          onChange={(checked) =>
                            setDraft((d) =>
                              d
                                ? {
                                    ...d,
                                    blockedSlots: checked
                                      ? [...d.blockedSlots, slot.value]
                                      : d.blockedSlots.filter(
                                          (value) => value !== slot.value,
                                        ),
                                  }
                                : d,
                            )
                          }
                          helpText={blocked ? "Blocked on this date" : undefined}
                        />
                      </div>
                      {!blocked && (
                        <InlineStack gap="200" blockAlign="center">
                          <div style={{ width: "120px" }}>
                            <TextField
                              label={`Capacity for ${slot.display}`}
                              labelHidden
                              type="number"
                              min={0}
                              autoComplete="off"
                              placeholder="No cap"
                              value={draft.capacities[slot.value] ?? ""}
                              onChange={(value) =>
                                setDraft((d) =>
                                  d
                                    ? {
                                        ...d,
                                        capacities: {
                                          ...d.capacities,
                                          [slot.value]: value,
                                        },
                                      }
                                    : d,
                                )
                              }
                            />
                          </div>
                          {typeof liveBooked === "number" && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {liveBooked} booked
                            </Text>
                          )}
                        </InlineStack>
                      )}
                    </InlineStack>
                  );
                })}
                {fieldErrors.capacities && (
                  <Text as="p" tone="critical" variant="bodySm">
                    {fieldErrors.capacities}
                  </Text>
                )}
                {fieldErrors.blockedSlots && (
                  <Text as="p" tone="critical" variant="bodySm">
                    {fieldErrors.blockedSlots}
                  </Text>
                )}
              </BlockStack>
            )}

            <ButtonGroup>
              <Button
                variant="primary"
                loading={submitting}
                onClick={() => {
                  const capacities: Record<string, number | null> = {};
                  for (const [slotValue, raw] of Object.entries(
                    draft.capacities,
                  )) {
                    const trimmed = raw.trim();
                    capacities[slotValue] =
                      trimmed === "" ? null : Number(trimmed);
                  }
                  submitOp("saveDayOverride", {
                    version,
                    date: selectedDate,
                    blocked: draft.blocked,
                    blockedSlots: draft.blocked ? [] : draft.blockedSlots,
                    capacities: draft.blocked ? {} : capacities,
                  });
                }}
              >
                Save day
              </Button>
              {hasStoredOverride && (
                <Button
                  tone="critical"
                  loading={submitting}
                  onClick={() =>
                    submitOp("clearDayOverride", {
                      version,
                      date: selectedDate,
                    })
                  }
                >
                  Clear overrides
                </Button>
              )}
              <Button onClick={() => selectDate(null)}>Close</Button>
            </ButtonGroup>
          </BlockStack>
        )}

        {upcoming.length > 0 && (
          <BlockStack gap="200">
            <Divider />
            <Text as="h3" variant="headingSm">
              Upcoming overrides
            </Text>
            <BlockStack gap="150">
              {upcoming.map((entry) => (
                <InlineStack key={entry.date} gap="200" blockAlign="center" wrap>
                  <Button
                    variant="plain"
                    onClick={() => selectDate(entry.date)}
                  >
                    {formatDateLabel(entry.date)}
                  </Button>
                  {entry.blocked && <Badge tone="critical">Blocked</Badge>}
                  {entry.blockedSlots.map((slotValue) => (
                    <Badge key={slotValue} tone="warning">
                      {`${slotValue} blocked`}
                    </Badge>
                  ))}
                  {entry.capacities.map(({ slotValue, capacity, booked }) => (
                    <Badge
                      key={slotValue}
                      tone={booked >= capacity ? "critical" : "info"}
                    >
                      {`${slotValue}: ${booked}/${capacity}`}
                    </Badge>
                  ))}
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
