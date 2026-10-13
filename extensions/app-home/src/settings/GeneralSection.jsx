import { useMemo, useState } from "preact/hooks";

import { formatHourLabel, useSchedulerOp } from "./use-scheduler-op";

function listTimezones(current) {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return supported.includes(current) || !current ? supported : [current, ...supported];
}

export function GeneralSection({ state, onSync }) {
  const { rules, version } = state;
  const [draft, setDraft] = useState({
    timezone: rules.timezone,
    cutoffHour: String(rules.cutoffHour),
    prepHours: String(rules.prepHours),
    maxDays: String(rules.maxDays),
  });

  const { submitOp, submitting, fieldErrors } = useSchedulerOp({
    onSync,
    successMessage: () => "Delivery settings saved",
  });

  const timezones = useMemo(() => listTimezones(rules.timezone), [rules.timezone]);

  const dirty =
    draft.timezone !== rules.timezone ||
    draft.cutoffHour !== String(rules.cutoffHour) ||
    draft.prepHours !== String(rules.prepHours) ||
    draft.maxDays !== String(rules.maxDays);

  function update(field) {
    return (event) => {
      const value = event.currentTarget.value;
      setDraft((d) => ({ ...d, [field]: value }));
    };
  }

  return (
    <s-section heading="Delivery settings">
      <s-stack gap="base">
        <s-text color="subdued">
          Store timezone, same-day cutoff, preparation time, and how far ahead customers can
          book.
        </s-text>

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          <s-select
            label="Timezone"
            value={draft.timezone}
            error={fieldErrors.timezone}
            onChange={update("timezone")}
          >
            {timezones.map((zone) => (
              <s-option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </s-option>
            ))}
          </s-select>
          <s-select
            label="Same-day cutoff"
            value={draft.cutoffHour}
            error={fieldErrors.cutoffHour}
            details="Orders after this time start from tomorrow."
            onChange={update("cutoffHour")}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <s-option key={hour} value={String(hour)}>
                {formatHourLabel(hour)}
              </s-option>
            ))}
          </s-select>
          <s-number-field
            label="Preparation time (hours)"
            min={0}
            max={72}
            value={draft.prepHours}
            error={fieldErrors.prepHours}
            onInput={update("prepHours")}
          />
          <s-number-field
            label="Booking window (days)"
            min={1}
            max={120}
            value={draft.maxDays}
            error={fieldErrors.maxDays}
            details="How many days ahead customers can choose."
            onInput={update("maxDays")}
          />
        </s-grid>

        <s-stack direction="inline">
          <s-button
            variant="primary"
            loading={submitting}
            disabled={!dirty || submitting}
            onClick={() =>
              submitOp("saveSettings", {
                version,
                timezone: draft.timezone,
                cutoffHour: draft.cutoffHour.trim(),
                prepHours: draft.prepHours.trim(),
                maxDays: draft.maxDays.trim(),
              })
            }
          >
            Save settings
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
