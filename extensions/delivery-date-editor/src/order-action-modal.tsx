import { useState, useCallback, useMemo } from 'react';
import { reactExtension, useApi } from '@shopify/ui-extensions-react/customer-account';

export default reactExtension(
  'customer-account.order.action.render',
  () => <RescheduleModal />,
);

const TIME_SLOT_OPTIONS = [
  { value: '9AM-12PM', label: '9AM – 12PM' },
  { value: '12PM-3PM', label: '12PM – 3PM' },
  { value: '3PM-6PM', label: '3PM – 6PM' },
  { value: '6PM-11PM', label: '6PM – 11PM' },
];

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function RescheduleModal() {
  const api = useApi<'customer-account.order.action.render'>();
  const [date, setDate] = useState('');
  const [timeSlot, setTimeSlot] = useState('');
  const [dateError, setDateError] = useState('');
  const [timeError, setTimeError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [confirmedDate, setConfirmedDate] = useState('');
  const [confirmedSlot, setConfirmedSlot] = useState('');

  const minDate = useMemo(() => todayISODate(), []);

  const validateAndSubmit = useCallback(async () => {
    let hasError = false;

    // Keep the local checks lightweight here so obviously invalid submissions are
    // blocked before the extension spends time resolving the proxy destination.
    if (!date) {
      setDateError('Please select a delivery date.');
      hasError = true;
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const [y, m, d] = date.split('-').map(Number);
      const selected = new Date(y, m - 1, d);
      if (selected < today) {
        setDateError('Please select a future delivery date.');
        hasError = true;
      } else {
        setDateError('');
      }
    }

    if (!timeSlot) {
      setTimeError('Please select a time slot.');
      hasError = true;
    } else {
      setTimeError('');
    }

    if (hasError) return;

    setIsSubmitting(true);
    setSubmitError('');

    try {
      // This legacy extension variant resolves the store domain first because it still
      // posts through the storefront app proxy instead of the newer direct app route.
      const result = await (api.query(
        'query { shop { primaryDomain { url } } }',
      ) as unknown as Promise<{ data?: { shop: { primaryDomain: { url: string } } } }>);

      const baseUrl = result.data?.shop?.primaryDomain?.url?.replace(/\/$/, '') ?? '';

      if (!baseUrl) {
        throw new Error('Could not determine store URL.');
      }

      const proxyUrl = `${baseUrl}/apps/schedule-rules/reschedule`;
      const orderId = api.orderId;

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, date, timeSlot }),
      });

      const body = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }

      // Move into local success state immediately after the proxy write so the modal
      // does not depend on the surrounding host page to re-read order data first.
      setConfirmedDate(date);
      setConfirmedSlot(timeSlot);
    } catch (err) {
      setSubmitError(
        (err as Error).message ?? 'Something went wrong. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [api, date, timeSlot]);

  if (confirmedDate) {
    const slotLabel =
      TIME_SLOT_OPTIONS.find((o) => o.value === confirmedSlot)?.label ??
      confirmedSlot;
    return (
      <s-customer-account-action heading="Delivery Rescheduled">
        <s-stack direction="block" gap="base">
          <s-banner tone="success">
            Your delivery has been rescheduled to {formatDisplayDate(confirmedDate)} ({slotLabel}).
          </s-banner>
        </s-stack>
        <s-button slot="primary-action" onClick={() => api.close()}>Done</s-button>
      </s-customer-account-action>
    );
  }

  return (
    <s-customer-account-action heading="Reschedule Delivery">
      <s-stack direction="block" gap="base">
        <s-text>Select a new delivery date and time slot.</s-text>
        {submitError && (
          <s-banner tone="critical">{submitError}</s-banner>
        )}
        <s-date-field
          label="New delivery date"
          value={date}
          allow={`${minDate}--`}
          error={dateError || undefined}
          onChange={(e: React.FormEvent<HTMLElement>) =>
            setDate((e.target as HTMLInputElement).value)
          }
        />
        <s-select
          label="Time slot"
          value={timeSlot}
          error={timeError || undefined}
          onChange={(e: React.FormEvent<HTMLElement>) =>
            setTimeSlot((e.target as HTMLSelectElement).value)
          }
        >
          <s-option value="">Select a time slot</s-option>
          {TIME_SLOT_OPTIONS.map((opt) => (
            <s-option key={opt.value} value={opt.value}>
              {opt.label}
            </s-option>
          ))}
        </s-select>
      </s-stack>
      <s-button
        slot="primary-action"
        loading={isSubmitting || undefined}
        disabled={isSubmitting || undefined}
        onClick={validateAndSubmit}
      >
        Confirm
      </s-button>
      <s-button slot="secondary-actions" onClick={() => api.close()}>
        Cancel
      </s-button>
    </s-customer-account-action>
  );
}
