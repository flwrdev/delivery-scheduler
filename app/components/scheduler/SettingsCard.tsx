import { useMemo, useState } from "react";
import {
  BlockStack,
  Button,
  Card,
  InlineGrid,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import type { SchedulerPageState } from "./op-plumbing";
import { formatHourLabel, useSchedulerOp } from "./op-plumbing";

function listTimezones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return supported.includes(current) || !current
    ? supported
    : [current, ...supported];
}

export function SettingsCard({
  state,
  onSync,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
}) {
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

  const timezoneOptions = useMemo(
    () =>
      listTimezones(rules.timezone).map((zone) => ({
        label: zone.replaceAll("_", " "),
        value: zone,
      })),
    [rules.timezone],
  );
  const cutoffOptions = useMemo(
    () =>
      Array.from({ length: 24 }, (_, hour) => ({
        label: formatHourLabel(hour),
        value: String(hour),
      })),
    [],
  );

  const dirty =
    draft.timezone !== rules.timezone ||
    draft.cutoffHour !== String(rules.cutoffHour) ||
    draft.prepHours !== String(rules.prepHours) ||
    draft.maxDays !== String(rules.maxDays);

  function handleSave() {
    submitOp("saveSettings", {
      version,
      timezone: draft.timezone,
      cutoffHour: draft.cutoffHour.trim(),
      prepHours: draft.prepHours.trim(),
      maxDays: draft.maxDays.trim(),
    });
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Delivery settings
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Store timezone, same-day cutoff, preparation time, and how far ahead
            customers can book.
          </Text>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          <Select
            label="Timezone"
            options={timezoneOptions}
            value={draft.timezone}
            onChange={(timezone) => setDraft((d) => ({ ...d, timezone }))}
            error={fieldErrors.timezone}
          />
          <Select
            label="Same-day cutoff"
            options={cutoffOptions}
            value={draft.cutoffHour}
            onChange={(cutoffHour) => setDraft((d) => ({ ...d, cutoffHour }))}
            error={fieldErrors.cutoffHour}
            helpText="Orders after this time start from tomorrow."
          />
          <TextField
            label="Preparation time (hours)"
            type="number"
            min={0}
            max={72}
            autoComplete="off"
            value={draft.prepHours}
            onChange={(prepHours) => setDraft((d) => ({ ...d, prepHours }))}
            error={fieldErrors.prepHours}
          />
          <TextField
            label="Booking window (days)"
            type="number"
            min={1}
            max={120}
            autoComplete="off"
            value={draft.maxDays}
            onChange={(maxDays) => setDraft((d) => ({ ...d, maxDays }))}
            error={fieldErrors.maxDays}
            helpText="How many days ahead customers can choose."
          />
        </InlineGrid>

        <div>
          <Button
            variant="primary"
            onClick={handleSave}
            loading={submitting}
            disabled={!dirty || submitting}
          >
            Save settings
          </Button>
        </div>
      </BlockStack>
    </Card>
  );
}
