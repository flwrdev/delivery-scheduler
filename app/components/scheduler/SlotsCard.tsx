// Scheduler card to manage the time slots: add, rename the display label, reorder and delete.
// A slot's time range cannot be edited; to change times, add a new slot and delete the old one.

import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import type { DeliveryScheduleRules } from "../../lib/delivery-availability";
import {
  generateSlotValue,
  isSlotRangeOrdered,
  parseSlotValueToTimes,
  type SlotTimePart,
} from "../../lib/slot-times";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  label: String(i + 1),
  value: String(i + 1),
}));
const MINUTE_OPTIONS = ["00", "15", "30", "45"].map((minute) => ({
  label: minute,
  value: minute,
}));
const MERIDIEM_OPTIONS = [
  { label: "AM", value: "AM" },
  { label: "PM", value: "PM" },
];

interface TimeDraft {
  hour: string;
  minute: string;
  meridiem: "AM" | "PM";
}

function toTimePart(draft: TimeDraft): SlotTimePart {
  return {
    hour: Number(draft.hour),
    minute: Number(draft.minute),
    meridiem: draft.meridiem,
  };
}

function TimePartPicker({
  label,
  draft,
  onChange,
}: {
  label: string;
  draft: TimeDraft;
  onChange: (draft: TimeDraft) => void;
}) {
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <InlineStack gap="100" wrap={false}>
        <Select
          label={`${label} hour`}
          labelHidden
          options={HOUR_OPTIONS}
          value={draft.hour}
          onChange={(hour) => onChange({ ...draft, hour })}
        />
        <Select
          label={`${label} minute`}
          labelHidden
          options={MINUTE_OPTIONS}
          value={draft.minute}
          onChange={(minute) => onChange({ ...draft, minute })}
        />
        <Select
          label={`${label} meridiem`}
          labelHidden
          options={MERIDIEM_OPTIONS}
          value={draft.meridiem}
          onChange={(meridiem) =>
            onChange({ ...draft, meridiem: meridiem as "AM" | "PM" })
          }
        />
      </InlineStack>
    </BlockStack>
  );
}

function affectedOverrides(
  rules: DeliveryScheduleRules,
  slotValue: string,
  today: string,
): string[] {
  const dates = new Set<string>();
  for (const [date, values] of Object.entries(rules.disabledSlots)) {
    if (date >= today && values.includes(slotValue)) {
      dates.add(date);
    }
  }
  for (const [date, capacities] of Object.entries(rules.slotCapacity)) {
    if (date >= today && slotValue in capacities) {
      dates.add(date);
    }
  }
  return [...dates].sort();
}

export function SlotsCard({
  state,
  onSync,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
}) {
  const { rules, version, today } = state;
  const [displayDrafts, setDisplayDrafts] = useState<Record<string, string>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<{
    start: TimeDraft;
    end: TimeDraft;
    display: string;
  }>({
    start: { hour: "9", minute: "00", meridiem: "AM" },
    end: { hour: "12", minute: "00", meridiem: "PM" },
    display: "",
  });

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) =>
      op === "deleteSlot"
        ? "Slot deleted"
        : op === "createSlot"
          ? "Slot added"
          : "Slots updated",
    onSuccess: (response) => {
      setDeleteTarget(null);
      setDisplayDrafts({});
      if (response.op === "createSlot") {
        setAddOpen(false);
        setAddDraft((d) => ({ ...d, display: "" }));
      }
    },
  });

  const addRange = useMemo(
    () => ({ start: toTimePart(addDraft.start), end: toTimePart(addDraft.end) }),
    [addDraft.start, addDraft.end],
  );
  const addPreview = generateSlotValue(addRange);
  const addRangeInvalid = !isSlotRangeOrdered(addRange);

  const deleteDates = deleteTarget
    ? affectedOverrides(rules, deleteTarget, today)
    : [];

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Time slots
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Checkout shows these windows in this order. Times are fixed once
              created — to change times, add a new slot and delete the old one.
            </Text>
          </BlockStack>
          <Button onClick={() => setAddOpen((open) => !open)}>
            {addOpen ? "Cancel" : "Add slot"}
          </Button>
        </InlineStack>

        {addOpen && (
          <Card background="bg-surface-secondary">
            <BlockStack gap="300">
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                <TimePartPicker
                  label="Start"
                  draft={addDraft.start}
                  onChange={(start) => setAddDraft((d) => ({ ...d, start }))}
                />
                <TimePartPicker
                  label="End"
                  draft={addDraft.end}
                  onChange={(end) => setAddDraft((d) => ({ ...d, end }))}
                />
              </InlineGrid>
              <TextField
                label="Display label"
                autoComplete="off"
                value={addDraft.display}
                placeholder={addPreview}
                onChange={(display) => setAddDraft((d) => ({ ...d, display }))}
                error={fieldErrors.display}
                helpText={`Slot value will be ${addPreview}`}
              />
              {(addRangeInvalid || fieldErrors.start || fieldErrors.end) && (
                <Text as="p" tone="critical" variant="bodySm">
                  {fieldErrors.start ??
                    fieldErrors.end ??
                    "End time must be after the start time."}
                </Text>
              )}
              <div>
                <Button
                  variant="primary"
                  loading={submitting}
                  disabled={addRangeInvalid || submitting}
                  onClick={() =>
                    submitOp("createSlot", {
                      version,
                      start: toTimePart(addDraft.start),
                      end: toTimePart(addDraft.end),
                      display: addDraft.display,
                    })
                  }
                >
                  Add slot
                </Button>
              </div>
            </BlockStack>
          </Card>
        )}

        <BlockStack gap="300">
          {rules.slots.map((slot, index) => {
            const structured = parseSlotValueToTimes(slot.value);
            const draft = displayDrafts[slot.value] ?? slot.display;
            const displayDirty = draft !== slot.display;

            return (
              <BlockStack key={slot.value} gap="200">
                {index > 0 && <Divider />}
                {!structured && (
                  <Banner tone="warning">
                    The value “{slot.value}” can’t be read as a time range, so
                    customers can never book it. Delete it and add a structured
                    slot in its place.
                  </Banner>
                )}
                <InlineStack gap="300" blockAlign="end" wrap>
                  <div style={{ minWidth: "200px", flexGrow: 1 }}>
                    <TextField
                      label="Display label"
                      labelHidden={false}
                      autoComplete="off"
                      value={draft}
                      onChange={(value) =>
                        setDisplayDrafts((drafts) => ({
                          ...drafts,
                          [slot.value]: value,
                        }))
                      }
                      error={displayDirty ? fieldErrors.display : undefined}
                      connectedRight={
                        displayDirty ? (
                          <Button
                            loading={submitting}
                            onClick={() =>
                              submitOp("updateSlotDisplay", {
                                version,
                                value: slot.value,
                                display: draft,
                              })
                            }
                          >
                            Save
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={structured ? "info" : "critical"}>
                      {slot.value}
                    </Badge>
                    <ButtonGroup>
                      <Button
                        accessibilityLabel={`Move ${slot.display} up`}
                        disabled={index === 0 || submitting}
                        onClick={() => {
                          const order = rules.slots.map((s) => s.value);
                          [order[index - 1], order[index]] = [
                            order[index],
                            order[index - 1],
                          ];
                          submitOp("reorderSlots", { version, order });
                        }}
                      >
                        ↑
                      </Button>
                      <Button
                        accessibilityLabel={`Move ${slot.display} down`}
                        disabled={index === rules.slots.length - 1 || submitting}
                        onClick={() => {
                          const order = rules.slots.map((s) => s.value);
                          [order[index], order[index + 1]] = [
                            order[index + 1],
                            order[index],
                          ];
                          submitOp("reorderSlots", { version, order });
                        }}
                      >
                        ↓
                      </Button>
                      <Button
                        tone="critical"
                        disabled={rules.slots.length <= 1 || submitting}
                        onClick={() => setDeleteTarget(slot.value)}
                      >
                        Delete
                      </Button>
                    </ButtonGroup>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            );
          })}
        </BlockStack>
      </BlockStack>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete slot ${deleteTarget ?? ""}?`}
        primaryAction={{
          content: "Delete slot",
          destructive: true,
          loading: submitting,
          onAction: () =>
            deleteTarget &&
            submitOp("deleteSlot", { version, value: deleteTarget }),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteTarget(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              Customers will no longer see this window at checkout.
            </Text>
            {deleteDates.length > 0 ? (
              <Text as="p" tone="caution">
                This also removes its blocked-slot and capacity overrides on:{" "}
                {deleteDates.map(formatDateLabel).join(", ")}.
              </Text>
            ) : (
              <Text as="p" tone="subdued">
                No date overrides reference this slot.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Card>
  );
}
