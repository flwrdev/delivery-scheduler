import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  ProgressBar,
  Text,
} from "@shopify/polaris";

import { buildSchedulerOverview } from "../../lib/scheduler-overview";
import type { SchedulerPageState } from "./op-plumbing";
import { formatDateLabel, useSchedulerOp } from "./op-plumbing";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="p" tone="subdued" variant="bodySm">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value}
      </Text>
    </BlockStack>
  );
}

export function OverviewCard({
  state,
  onSync,
  onSelectDate,
}: {
  state: SchedulerPageState;
  onSync: (state: SchedulerPageState) => void;
  onSelectDate: (date: string) => void;
}) {
  const { rules, countsMeta, today } = state;
  const overview = buildSchedulerOverview(rules, today);
  const { submitOp, submitting } = useSchedulerOp({
    onSync,
    successMessage: () => "Live counts refreshed",
  });

  const countsCaption =
    countsMeta.status === "ok" && countsMeta.fetchedAt
      ? `Live counts ${countsMeta.fromCache ? "cached" : "refreshed"} ${new Date(
          countsMeta.fetchedAt,
        ).toLocaleTimeString()}`
      : countsMeta.status === "untracked"
        ? "No capacity-tracked dates yet"
        : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Overview
          </Text>
          <InlineStack gap="200" blockAlign="center">
            {countsCaption && (
              <Text as="span" tone="subdued" variant="bodySm">
                {countsCaption}
              </Text>
            )}
            <Button
              loading={submitting}
              onClick={() => submitOp("refreshCounts", {})}
            >
              Refresh counts
            </Button>
          </InlineStack>
        </InlineStack>

        <InlineGrid columns={{ xs: 2, sm: 4 }} gap="300">
          <Stat label="Delivery slots" value={String(overview.slotCount)} />
          <Stat
            label="Blocked dates"
            value={String(overview.blockedDateCount)}
          />
          <Stat
            label="Capacity days"
            value={String(overview.trackedCapacityDayCount)}
          />
          <Stat
            label="At capacity"
            value={`${overview.fullCount} full / ${overview.nearLimitCount} near`}
          />
        </InlineGrid>

        {overview.watchlist.length > 0 && (
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Capacity watchlist
            </Text>
            <BlockStack gap="200">
              {overview.watchlist.map((entry) => (
                <InlineStack
                  key={`${entry.date}-${entry.slotValue}`}
                  gap="300"
                  blockAlign="center"
                  wrap
                >
                  <div style={{ minWidth: "150px" }}>
                    <Button
                      variant="plain"
                      onClick={() => onSelectDate(entry.date)}
                    >
                      {`${formatDateLabel(entry.date)} · ${entry.slotValue}`}
                    </Button>
                  </div>
                  <Badge tone={entry.status.tone}>{entry.status.label}</Badge>
                  <div style={{ flexGrow: 1, minWidth: "120px" }}>
                    <ProgressBar
                      progress={entry.utilizationPercent}
                      size="small"
                      tone={
                        entry.status.label === "Full" ? "critical" : "primary"
                      }
                    />
                  </div>
                  <Text as="span" tone="subdued" variant="bodySm">
                    {`${entry.booked} of ${entry.capacity} booked`}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
