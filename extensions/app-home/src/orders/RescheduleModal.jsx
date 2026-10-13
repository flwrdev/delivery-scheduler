import { useEffect, useMemo, useState } from "preact/hooks";

import { findSlotOverrideKey, slotValuesMatch } from "../../../../app/lib/slot-value";
import { getShopLocalDate } from "../../../../app/lib/delivery-availability";

export const RESCHEDULE_MODAL_ID = "orders-reschedule-modal";

/**
 * "Update delivery slot" for N target orders. Blocked dates/slots hard-block;
 * a capacity overrun becomes an explicit "Reschedule anyway" step.
 */
export function RescheduleModal({
  modalRef,
  openCount,
  targets,
  isSubmitting,
  rules,
  rulesLoading,
  serverCapacity,
  onConfirm,
  onHide,
}) {
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  const [lastSubmitted, setLastSubmitted] = useState(null);

  useEffect(() => {
    if (openCount === 0) return;
    const single = targets.length === 1 ? targets[0] : null;
    setDate(single?.currentDate ?? "");
    setSlot(single?.currentSlot ?? "");
    setNotifyCustomer(true);
    setLastSubmitted(null);
  }, [openCount]);

  const dateBlocked = Boolean(rules && date && rules.disabledDates.includes(date));

  const slotOptions = useMemo(() => {
    const disabledForDate = rules?.disabledSlots?.[date] ?? [];
    const caps = rules?.slotCapacity?.[date];
    return (rules?.slots ?? []).map((s) => {
      const capKey = caps ? findSlotOverrideKey(Object.keys(caps), s.value) : null;
      const cap = capKey == null ? undefined : caps?.[capKey];
      const blocked = findSlotOverrideKey(disabledForDate, s.value) != null;
      const suffix = blocked ? " — blocked" : cap ? ` — ${cap.booked}/${cap.capacity} booked` : "";
      return { label: `${s.display}${suffix}`, value: s.value, disabled: blocked };
    });
  }, [rules, date]);

  const clientCapacity = useMemo(() => {
    const caps = rules?.slotCapacity?.[date];
    const capKey = caps && slot ? findSlotOverrideKey(Object.keys(caps), slot) : null;
    const cap = capKey == null ? undefined : caps?.[capKey];
    if (!cap) return null;
    const moving = targets.filter(
      (t) => t.currentDate !== date || !slotValuesMatch(t.currentSlot, slot),
    ).length;
    return {
      capacity: Number(cap.capacity),
      booked: Number(cap.booked),
      moving,
      projected: Number(cap.booked) + moving,
    };
  }, [rules, date, slot, targets]);

  const shopTodayISO = rules ? getShopLocalDate(rules.timezone) : "";
  const dateInPast = Boolean(
    shopTodayISO && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < shopTodayISO,
  );

  const serverWarningActive = Boolean(
    serverCapacity && lastSubmitted && lastSubmitted.date === date && lastSubmitted.slot === slot,
  );
  const capacityWarning = serverWarningActive
    ? serverCapacity
    : clientCapacity && clientCapacity.moving > 0 && clientCapacity.projected > clientCapacity.capacity
      ? clientCapacity
      : null;

  const targetCount = targets.length;
  const targetLabel = targetCount === 1 ? `order ${targets[0].name}` : `${targetCount} orders`;
  const slotBlocked = Boolean(
    slot && findSlotOverrideKey(rules?.disabledSlots?.[date] ?? [], slot) != null,
  );
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
    onConfirm(date, slot, Boolean(capacityWarning), notifyCustomer);
  };

  return (
    <s-modal id={RESCHEDULE_MODAL_ID} ref={modalRef} heading="Update delivery slot" onHide={onHide}>
      <s-stack gap="base">
        <s-paragraph>{`Set a new delivery date and time slot for ${targetLabel}.`}</s-paragraph>
        {rulesLoading && <s-text color="subdued">Loading delivery settings…</s-text>}
        {!rulesLoading && rules === null && (
          <s-banner tone="critical">
            Couldn’t load the delivery settings. Close this dialog and try again.
          </s-banner>
        )}
        <s-date-field
          label="Delivery date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          error={dateBlocked ? "That date is blocked in the delivery settings." : undefined}
          details="Administrative override — customer booking limits (cutoff, lead time, reschedule lock) don't apply here."
        />
        {dateInPast && (
          <s-banner tone="warning" heading="This date is in the past">
            {`${date} is before today (${shopTodayISO}) on the shop calendar — the order will immediately show as overdue. Double-check the year before confirming.`}
          </s-banner>
        )}
        <s-select
          label="Time slot"
          placeholder="Select a time slot"
          value={slot}
          disabled={rules === null}
          onChange={(e) => setSlot(e.currentTarget.value)}
          error={slotBlocked ? "That time slot is blocked for the selected date." : undefined}
        >
          {slotOptions.map((o) => (
            <s-option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </s-option>
          ))}
        </s-select>
        {capacityWarning && (
          <s-banner tone="warning" heading="This slot will exceed its capacity">
            {`${date} ${slot} is at ${capacityWarning.booked}/${capacityWarning.capacity}. Moving ${capacityWarning.moving} ${
              capacityWarning.moving === 1 ? "order" : "orders"
            } puts it at ${capacityWarning.projected}/${capacityWarning.capacity}. Confirming overrides the capacity limit.`}
          </s-banner>
        )}
        <s-checkbox
          label="Email the customer about the new schedule"
          checked={notifyCustomer}
          disabled={isSubmitting}
          onChange={(e) => setNotifyCustomer(e.currentTarget.checked)}
          details="Plain-text email from your business mailbox, sent right after the update. Skipped for orders without a customer email."
        />
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        tone={capacityWarning ? "critical" : "auto"}
        loading={isSubmitting}
        disabled={!canSubmit}
        onClick={handleConfirm}
      >
        {isSubmitting
          ? "Updating…"
          : capacityWarning
            ? `Reschedule anyway (${capacityWarning.projected}/${capacityWarning.capacity})`
            : "Update delivery"}
      </s-button>
      <s-button
        slot="secondary-actions"
        commandFor={RESCHEDULE_MODAL_ID}
        command="--hide"
        disabled={isSubmitting}
      >
        Cancel
      </s-button>
    </s-modal>
  );
}
