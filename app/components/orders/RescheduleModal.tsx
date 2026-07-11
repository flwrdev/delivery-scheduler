import { useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  Modal,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import type { RescheduleRulesData } from "../../routes/app.orders_.reschedule-rules";

// "Update delivery slot" modal (Phase 4) — one date+slot applied to N target
// orders. Serves both the bulk-actions bar (selection) and the details
// panel's single-order action. Merchant path = administrative override (§5):
// only data-integrity problems (blocked date/slot, unknown slot) hard-block
// here; capacity overload renders as an explicit warn+confirm step (REC-4).
export interface RescheduleTarget {
  id: string;
  name: string;
  currentDate: string | null;
  currentSlot: string | null;
}

export interface RescheduleCapacityInfo {
  capacity: number;
  booked: number;
  moving: number;
  projected: number;
}

export interface RescheduleModalProps {
  open: boolean;
  onClose: () => void;
  targets: RescheduleTarget[];
  isSubmitting: boolean;
  rules: RescheduleRulesData | null;
  rulesLoading: boolean;
  // Server-side capacity backstop (action responded capacity_override_required
  // because the client's booked counts were stale).
  serverCapacity: RescheduleCapacityInfo | null;
  onConfirm: (date: string, timeSlot: string, override: boolean) => void;
}

export function RescheduleModal({
  open,
  onClose,
  targets,
  isSubmitting,
  rules,
  rulesLoading,
  serverCapacity,
  onConfirm,
}: RescheduleModalProps) {
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  // The server capacity warning belongs to one specific submit — remember
  // what was submitted so editing the date/slot afterwards drops the warning.
  const [lastSubmitted, setLastSubmitted] = useState<{
    date: string;
    slot: string;
  } | null>(null);

  // Reset (and prefill for a single target) each time the modal opens.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const single = targets.length === 1 ? targets[0] : null;
      setDate(single?.currentDate ?? "");
      setSlot(single?.currentSlot ?? "");
      setLastSubmitted(null);
    }
    wasOpenRef.current = open;
  }, [open, targets]);

  const dateBlocked = Boolean(
    rules && date && rules.disabledDates.includes(date),
  );
  const blockedSlotsForDate = useMemo(
    () => new Set(rules?.disabledSlots?.[date] ?? []),
    [rules, date],
  );

  const slotOptions = useMemo(() => {
    const options = (rules?.slots ?? []).map((s) => {
      const cap = rules?.slotCapacity?.[date]?.[s.value];
      const blocked = blockedSlotsForDate.has(s.value);
      const suffix = blocked
        ? " — blocked"
        : cap
          ? ` — ${cap.booked}/${cap.capacity} booked`
          : "";
      return {
        label: `${s.display}${suffix}`,
        value: s.value,
        disabled: blocked,
      };
    });
    return [{ label: "Select a time slot", value: "", disabled: true }, ...options];
  }, [rules, date, blockedSlotsForDate]);

  // Client-side projected load (REC-4): orders already in the target
  // date+slot don't count against the remaining capacity.
  const clientCapacity = useMemo<RescheduleCapacityInfo | null>(() => {
    const cap = rules?.slotCapacity?.[date]?.[slot];
    if (!cap) return null;
    const moving = targets.filter(
      (t) => t.currentDate !== date || t.currentSlot !== slot,
    ).length;
    return {
      capacity: Number(cap.capacity),
      booked: Number(cap.booked),
      moving,
      projected: Number(cap.booked) + moving,
    };
  }, [rules, date, slot, targets]);

  const serverWarningActive = Boolean(
    serverCapacity &&
      lastSubmitted &&
      lastSubmitted.date === date &&
      lastSubmitted.slot === slot,
  );
  const capacityWarning = serverWarningActive
    ? serverCapacity
    : clientCapacity &&
        clientCapacity.moving > 0 &&
        clientCapacity.projected > clientCapacity.capacity
      ? clientCapacity
      : null;

  const targetCount = targets.length;
  const targetLabel =
    targetCount === 1
      ? `order ${targets[0].name}`
      : `${targetCount} orders`;
  const slotBlocked = Boolean(slot && blockedSlotsForDate.has(slot));
  const canSubmit =
    !isSubmitting &&
    targetCount > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Boolean(slot) &&
    !dateBlocked &&
    !slotBlocked &&
    rules !== null;

  const handleConfirm = () => {
    setLastSubmitted({ date, slot });
    onConfirm(date, slot, Boolean(capacityWarning));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Update delivery slot"
      primaryAction={{
        content: isSubmitting
          ? "Updating…"
          : capacityWarning
            ? `Reschedule anyway (${capacityWarning.projected}/${capacityWarning.capacity})`
            : "Update delivery",
        onAction: handleConfirm,
        destructive: Boolean(capacityWarning),
        loading: isSubmitting,
        disabled: !canSubmit,
      }}
      secondaryActions={[
        { content: "Cancel", onAction: onClose, disabled: isSubmitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">
            Set a new delivery date and time slot for {targetLabel}.
          </Text>
          {rulesLoading && (
            <Text as="p" tone="subdued">
              Loading delivery settings…
            </Text>
          )}
          {!rulesLoading && rules === null && (
            <Banner tone="critical">
              <Text as="p">
                Couldn’t load the delivery settings. Close this dialog and try
                again.
              </Text>
            </Banner>
          )}
          <TextField
            label="Delivery date"
            type="date"
            value={date}
            onChange={setDate}
            autoComplete="off"
            error={
              dateBlocked
                ? "That date is blocked in the delivery settings."
                : undefined
            }
            helpText="Administrative override — customer booking limits (cutoff, lead time, reschedule lock) don't apply here."
          />
          <Select
            label="Time slot"
            options={slotOptions}
            value={slot}
            onChange={setSlot}
            disabled={rules === null}
            error={
              slotBlocked
                ? "That time slot is blocked for the selected date."
                : undefined
            }
          />
          {capacityWarning && (
            <Banner tone="warning" title="This slot will exceed its capacity">
              <Text as="p">
                {date} {slot} is at {capacityWarning.booked}/
                {capacityWarning.capacity}. Moving {capacityWarning.moving}{" "}
                {capacityWarning.moving === 1 ? "order" : "orders"} puts it at{" "}
                {capacityWarning.projected}/{capacityWarning.capacity}.
                Confirming overrides the capacity limit.
              </Text>
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
