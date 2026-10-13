import { useMemo, useRef, useState } from "preact/hooks";

import {
  generateSlotValue,
  isSlotRangeOrdered,
  parseSlotValueToTimes,
} from "../../../../app/lib/slot-times";
import { formatDateLabel, useSchedulerOp } from "./use-scheduler-op";

const DELETE_MODAL_ID = "delete-slot-modal";
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = ["00", "15", "30", "45"];
const MERIDIEMS = ["AM", "PM"];

function toTimePart(draft) {
  return {
    hour: Number(draft.hour),
    minute: Number(draft.minute),
    meridiem: draft.meridiem,
  };
}

function TimePartPicker({ label, draft, onChange }) {
  const field = (key) => (event) => onChange({ ...draft, [key]: event.currentTarget.value });
  return (
    <s-stack gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-stack direction="inline" gap="small-200">
        <s-select label={`${label} hour`} labelAccessibilityVisibility="exclusive" value={draft.hour} onChange={field("hour")}>
          {HOURS.map((hour) => (
            <s-option key={hour} value={hour}>
              {hour}
            </s-option>
          ))}
        </s-select>
        <s-select label={`${label} minute`} labelAccessibilityVisibility="exclusive" value={draft.minute} onChange={field("minute")}>
          {MINUTES.map((minute) => (
            <s-option key={minute} value={minute}>
              {minute}
            </s-option>
          ))}
        </s-select>
        <s-select label={`${label} meridiem`} labelAccessibilityVisibility="exclusive" value={draft.meridiem} onChange={field("meridiem")}>
          {MERIDIEMS.map((meridiem) => (
            <s-option key={meridiem} value={meridiem}>
              {meridiem}
            </s-option>
          ))}
        </s-select>
      </s-stack>
    </s-stack>
  );
}

function affectedOverrides(rules, slotValue, today) {
  const dates = new Set();
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

export function SlotsSection({ state, onSync }) {
  const { rules, version, today } = state;
  const deleteModalRef = useRef(null);
  const [displayDrafts, setDisplayDrafts] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState({
    start: { hour: "9", minute: "00", meridiem: "AM" },
    end: { hour: "12", minute: "00", meridiem: "PM" },
    display: "",
  });

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: (op) =>
      op === "deleteSlot" ? "Slot deleted" : op === "createSlot" ? "Slot added" : "Slots updated",
    onSuccess: (response) => {
      setDeleteTarget(null);
      deleteModalRef.current?.hideOverlay?.();
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
  const deleteDates = deleteTarget ? affectedOverrides(rules, deleteTarget, today) : [];

  function moveSlot(index, offset) {
    const order = rules.slots.map((s) => s.value);
    [order[index], order[index + offset]] = [order[index + offset], order[index]];
    submitOp("reorderSlots", { version, order });
  }

  return (
    <s-section heading="Time slots">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-text color="subdued">
            Checkout shows these windows in this order. Times are fixed once created — to change
            times, add a new slot and delete the old one.
          </s-text>
          <s-button onClick={() => setAddOpen((open) => !open)}>
            {addOpen ? "Cancel" : "Add slot"}
          </s-button>
        </s-stack>

        {addOpen && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="base">
              <s-stack direction="inline" gap="large">
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
              </s-stack>
              <s-text-field
                label="Display label"
                value={addDraft.display}
                placeholder={addPreview}
                error={fieldErrors.display}
                details={`Slot value will be ${addPreview}`}
                onInput={(event) => {
                  const display = event.currentTarget.value;
                  setAddDraft((d) => ({ ...d, display }));
                }}
              />
              {(addRangeInvalid || fieldErrors.start || fieldErrors.end) && (
                <s-text tone="critical">
                  {fieldErrors.start ?? fieldErrors.end ?? "End time must be after the start time."}
                </s-text>
              )}
              <s-stack direction="inline">
                <s-button
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
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        )}

        {rules.slots.map((slot, index) => {
          const structured = parseSlotValueToTimes(slot.value);
          const draft = displayDrafts[slot.value] ?? slot.display;
          const displayDirty = draft !== slot.display;

          return (
            <s-stack key={slot.value} gap="small">
              {index > 0 && <s-divider />}
              {!structured && (
                <s-banner tone="warning">
                  The value “{slot.value}” can’t be read as a time range, so customers can never
                  book it. Delete it and add a structured slot in its place.
                </s-banner>
              )}
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-text-field
                  label="Display label"
                  value={draft}
                  error={displayDirty ? fieldErrors.display : undefined}
                  onInput={(event) => {
                    const value = event.currentTarget.value;
                    setDisplayDrafts((drafts) => ({ ...drafts, [slot.value]: value }));
                  }}
                />
                {displayDirty && (
                  <s-button
                    loading={submitting}
                    onClick={() =>
                      submitOp("updateSlotDisplay", { version, value: slot.value, display: draft })
                    }
                  >
                    Save
                  </s-button>
                )}
                <s-badge tone={structured ? "info" : "critical"}>{slot.value}</s-badge>
                <s-button
                  accessibilityLabel={`Move ${slot.display} up`}
                  disabled={index === 0 || submitting}
                  onClick={() => moveSlot(index, -1)}
                >
                  ↑
                </s-button>
                <s-button
                  accessibilityLabel={`Move ${slot.display} down`}
                  disabled={index === rules.slots.length - 1 || submitting}
                  onClick={() => moveSlot(index, 1)}
                >
                  ↓
                </s-button>
                <s-button
                  tone="critical"
                  disabled={rules.slots.length <= 1 || submitting}
                  commandFor={DELETE_MODAL_ID}
                  command="--show"
                  onClick={() => setDeleteTarget(slot.value)}
                >
                  Delete
                </s-button>
              </s-stack>
            </s-stack>
          );
        })}
      </s-stack>

      <s-modal
        id={DELETE_MODAL_ID}
        ref={deleteModalRef}
        heading={`Delete slot ${deleteTarget ?? ""}?`}
        onHide={() => setDeleteTarget(null)}
      >
        <s-stack gap="small">
          <s-paragraph>Customers will no longer see this window at checkout.</s-paragraph>
          {deleteDates.length > 0 ? (
            <s-paragraph tone="caution">
              This also removes its blocked-slot and capacity overrides on:{" "}
              {deleteDates.map(formatDateLabel).join(", ")}.
            </s-paragraph>
          ) : (
            <s-paragraph color="subdued">No date overrides reference this slot.</s-paragraph>
          )}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={submitting}
          onClick={() => deleteTarget && submitOp("deleteSlot", { version, value: deleteTarget })}
        >
          Delete slot
        </s-button>
        <s-button slot="secondary-actions" commandFor={DELETE_MODAL_ID} command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-section>
  );
}
