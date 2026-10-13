import { useState } from "preact/hooks";

import { submitSchedulerOp } from "../scheduler-api";

export const STALE_CONFIG_MESSAGE =
  "Schedule settings changed in another session — this page just reloaded the latest values. Re-apply your edit.";

export function useSchedulerOp({ onSync, onSuccess, successMessage }) {
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  async function submitOp(op, input) {
    setSubmitting(true);
    let data;
    try {
      data = await submitSchedulerOp(op, { op, ...input });
    } finally {
      setSubmitting(false);
    }

    if (data.ok) {
      setFieldErrors({});
      onSync({
        rules: data.rules,
        version: data.version,
        configHealth: data.configHealth,
        countsMeta: data.countsMeta,
        today: data.today,
      });
      const message = successMessage?.(data.op) ?? "Saved";
      if (message) {
        shopify.toast.show(message);
      }
      onSuccess?.(data);
      return;
    }

    if (data.code === "validation") {
      setFieldErrors(data.fieldErrors ?? {});
      const first = Object.values(data.fieldErrors ?? {})[0];
      shopify.toast.show(first ?? "Check the highlighted fields.", { isError: true });
      return;
    }

    if (data.code === "stale_config") {
      setFieldErrors({});
      if (data.rules && typeof data.version === "number") {
        onSync({
          rules: data.rules,
          version: data.version,
          configHealth: data.configHealth ?? [],
          countsMeta: data.countsMeta ?? {
            status: "skipped",
            fetchedAt: null,
            fromCache: false,
          },
          today: data.today ?? new Date().toISOString().slice(0, 10),
        });
      }
      shopify.toast.show(STALE_CONFIG_MESSAGE, { isError: true });
      return;
    }

    shopify.toast.show(data.message ?? "Something went wrong. Try again.", {
      isError: true,
    });
  }

  return { submitOp, submitting, fieldErrors, setFieldErrors };
}

export function formatHourLabel(hour) {
  const meridiem = hour < 12 ? "AM" : "PM";
  const base = hour % 12 === 0 ? 12 : hour % 12;
  return `${base}:00 ${meridiem}`;
}

export function formatDateLabel(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
