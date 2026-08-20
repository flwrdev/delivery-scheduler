// Reminders — kill switch + analytics + template editor + activity feed for
// the occasion reminder emails (the nightly auto-send in
// services/occasion-reminders.server.ts). Writes:
//   - ReminderConfig.enabled (the kill switch),
//   - ReminderConfig.subject7d/body7d/subject3d/body3d (merchant templates;
//     null = built-in default; the unsubscribe footer is server-appended at
//     send time so an edit can never strip it),
//   - ReminderSuppression rows (the merchant "Suppress" escape hatch, which
//     also flips that email's PENDING rows to SUPPRESSED).
// Postgres only — ZERO Shopify writes (the one Admin GraphQL call here is a
// read-only ANNIV200 usage-count query); none of this touches delivery state
// (see api.md §2 vicinity note). Per ADR-11, the action always answers
// 200 + { ok, ... }.

import { useCallback, useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Icon,
  Layout,
  Page,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import type { OccasionReminder } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { recordSuppression } from "../services/occasion-reminders.server";
import {
  REMINDER_DISCOUNT_CODE,
  REMINDER_DISCOUNT_LABEL,
} from "../services/reminder-copy.server";
import {
  DEFAULT_TEMPLATE_TEXTS,
  REMINDER_TEMPLATE_TOKENS,
  renderReminderTemplate,
  SAMPLE_TEMPLATE_VARS,
} from "../lib/reminder-template";

const ACTIVITY_LIMIT = 50;
// Mirrors MAX_EMAIL_SUBJECT_LENGTH / MAX_EMAIL_BODY_LENGTH sa
// send-customer-email.server.ts (literals — client bundle cannot import a
// .server module). Body cap leaves ~500 chars of headroom for the footer.
const TEMPLATE_SUBJECT_MAX = 200;
const TEMPLATE_BODY_MAX = 4500;

interface ReminderRowView {
  id: string;
  orderIdTail: string;
  occasionDate: string;
  occasionType: string;
  touch: string;
  status: string;
  customerEmail: string | null;
  customerFirstName: string | null;
  recipientName: string | null;
  sentAt: string | null;
  converted: boolean;
}

const ANNIV200_USAGE_QUERY = `#graphql
  query Anniv200Usage {
    codeDiscountNodeByCode(code: "${REMINDER_DISCOUNT_CODE}") {
      codeDiscount {
        ... on DiscountCodeBasic {
          status
          asyncUsageCount
        }
      }
    }
  }
`;

export const loader = async ({ request }: { request: Request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, rows, suppressionCount, sent7d, sent3d, failedCount, convertedGroups, reachedGroups] =
    await Promise.all([
      prisma.reminderConfig.findUnique({ where: { shop } }),
      prisma.occasionReminder.findMany({
        where: { shop },
        orderBy: [{ updatedAt: "desc" }],
        take: ACTIVITY_LIMIT,
      }),
      prisma.reminderSuppression.count({ where: { shop } }),
      prisma.occasionReminder.count({ where: { shop, touch: "7d", status: "SENT" } }),
      prisma.occasionReminder.count({ where: { shop, touch: "3d", status: "SENT" } }),
      prisma.occasionReminder.count({ where: { shop, status: "FAILED" } }),
      prisma.occasionReminder.groupBy({
        by: ["shopifyOrderId", "occasionYear"],
        where: { shop, convertedAt: { not: null } },
      }),
      prisma.occasionReminder.groupBy({
        by: ["shopifyOrderId", "occasionYear"],
        where: { shop, status: "SENT" },
      }),
    ]);

  // ANNIV200 redemptions — read-only; a failure just hides the stat.
  let discountUsageCount: number | null = null;
  try {
    const resp = await admin.graphql(ANNIV200_USAGE_QUERY);
    const json = (await resp.json()) as {
      data?: {
        codeDiscountNodeByCode?: {
          codeDiscount?: { status?: string; asyncUsageCount?: number };
        } | null;
      };
    };
    discountUsageCount = json.data?.codeDiscountNodeByCode?.codeDiscount?.asyncUsageCount ?? null;
  } catch (error) {
    console.warn(
      `[reminders] discount usage query failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const convertedOccasions = convertedGroups.length;
  const reachedOccasions = reachedGroups.length;

  return {
    enabled: config?.enabled ?? false,
    emailConfigured: Boolean(
      process.env.EMAIL_SMTP_USER?.trim() && process.env.EMAIL_SMTP_PASSWORD?.trim(),
    ),
    suppressionCount,
    discountCode: REMINDER_DISCOUNT_CODE,
    discountLabel: REMINDER_DISCOUNT_LABEL,
    stats: {
      sent7d,
      sent3d,
      failedCount,
      convertedOccasions,
      reachedOccasions,
      conversionRate:
        reachedOccasions > 0 ? Math.round((convertedOccasions / reachedOccasions) * 100) : null,
      discountUsageCount,
    },
    templates: {
      subject7d: config?.subject7d ?? "",
      body7d: config?.body7d ?? "",
      subject3d: config?.subject3d ?? "",
      body3d: config?.body3d ?? "",
    },
    reminders: rows.map((row: OccasionReminder): ReminderRowView => ({
      id: row.id,
      orderIdTail: row.shopifyOrderId.split("/").pop() ?? row.shopifyOrderId,
      occasionDate: row.occasionDate.toISOString().slice(0, 10),
      occasionType: row.occasionType,
      touch: row.touch,
      status: row.status,
      customerEmail: row.customerEmail,
      customerFirstName: row.customerFirstName,
      recipientName: row.recipientHint,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      converted: Boolean(row.convertedAt),
    })),
  };
};

export const action = async ({ request }: { request: Request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const op = String(form.get("_action") ?? "");

  try {
    if (op === "saveConfig") {
      const enabled = form.get("enabled") === "true";
      await prisma.reminderConfig.upsert({
        where: { shop },
        update: { enabled },
        create: { shop, enabled },
      });
      return { ok: true, op };
    }

    if (op === "saveTemplates") {
      // Blank field → null → built-in default for that field.
      const clean = (key: string, max: number): string | null | { error: string } => {
        const raw = String(form.get(key) ?? "").trim();
        if (!raw) return null;
        if (raw.length > max) {
          return { error: `${key}: must be ${max} characters or fewer (currently ${raw.length}).` };
        }
        return raw;
      };
      const fields = {
        subject7d: clean("subject7d", TEMPLATE_SUBJECT_MAX),
        body7d: clean("body7d", TEMPLATE_BODY_MAX),
        subject3d: clean("subject3d", TEMPLATE_SUBJECT_MAX),
        body3d: clean("body3d", TEMPLATE_BODY_MAX),
      };
      for (const value of Object.values(fields)) {
        if (value && typeof value === "object") {
          return { ok: false, op, error: value.error };
        }
      }
      const data = fields as Record<keyof typeof fields, string | null>;
      await prisma.reminderConfig.upsert({
        where: { shop },
        update: data,
        create: { shop, enabled: false, ...data },
      });
      return { ok: true, op };
    }

    if (op === "suppress") {
      const reminderId = String(form.get("reminderId") ?? "");
      if (!reminderId) return { ok: false, op, error: "Missing reminder id." };
      const row = await prisma.occasionReminder.findUnique({ where: { id: reminderId } });
      if (!row || row.shop !== shop) {
        return { ok: false, op, error: "Reminder not found." };
      }
      if (!row.customerEmail) {
        return { ok: false, op, error: "This reminder has no email address." };
      }
      await recordSuppression(shop, row.customerEmail, "all", "merchant");
      return { ok: true, op };
    }

    return { ok: false, op, error: "Unknown action." };
  } catch (error) {
    // ADR-11: never bubble a raw 5xx through the embedded fetcher.
    console.error("[reminders] action failed:", error);
    return { ok: false, op, error: "Something went wrong. Try again." };
  }
};

// Status literals mirrored from REMINDER_STATUS in occasion-reminders.server —
// the client bundle cannot import a .server module (same constraint the
// cod-settings page documents for COD_FEE_SKU), so the component matches on
// the wire strings directly.
function statusBadge(status: string): { tone: "success" | "attention" | "critical" | "info" | undefined; label: string } {
  switch (status) {
    case "SENT":
      return { tone: "success", label: "Sent" };
    case "PENDING":
      return { tone: "attention", label: "Pending" };
    case "FAILED":
      return { tone: "critical", label: "Failed" };
    case "SKIPPED_REORDERED":
      return { tone: "info", label: "Skipped (reordered)" };
    case "SUPPRESSED":
      return { tone: undefined, label: "Suppressed" };
    default:
      return { tone: undefined, label: status };
  }
}

// Label-above-value, matching the Orders Operations KPI cards.
function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <Box minWidth="120px">
      <BlockStack gap="050">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="headingLg">{value}</Text>
      </BlockStack>
    </Box>
  );
}

// Long explanations live in hover tooltips (merchant request 2026-08-21:
// one-glance scannable page; paragraphs live behind Polaris info icons).
function InfoTip({ content }: { content: string }) {
  return (
    <Tooltip content={content} width="wide">
      <Icon source={InfoIcon} tone="subdued" accessibilityLabel="More information" />
    </Tooltip>
  );
}

function TemplateEditor({
  title,
  tooltip,
  subject,
  body,
  onSubject,
  onBody,
  disabled,
}: {
  title: string;
  tooltip: string;
  subject: string;
  body: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  disabled: boolean;
}) {
  const previewSubject = renderReminderTemplate(subject, SAMPLE_TEMPLATE_VARS);
  const previewBody = renderReminderTemplate(body, SAMPLE_TEMPLATE_VARS);
  return (
    <BlockStack gap="300">
      <InlineStack gap="150" blockAlign="center">
        <Text as="h3" variant="headingSm">{title}</Text>
        <InfoTip content={tooltip} />
      </InlineStack>
      <TextField
        label="Subject"
        value={subject}
        onChange={onSubject}
        autoComplete="off"
        disabled={disabled}
        maxLength={TEMPLATE_SUBJECT_MAX}
      />
      <TextField
        label="Body"
        value={body}
        onChange={onBody}
        autoComplete="off"
        multiline={8}
        disabled={disabled}
        maxLength={TEMPLATE_BODY_MAX}
        helpText="Unsubscribe footer is added automatically."
      />
      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" fontWeight="semibold">
            Preview · sample data
          </Text>
          <Text as="p" variant="bodySm" fontWeight="medium">{previewSubject}</Text>
          <div style={{ whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: "1.5" }}>
            {previewBody}
          </div>
        </BlockStack>
      </Box>
    </BlockStack>
  );
}

export default function RemindersPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [enabled, setEnabled] = useState(data.enabled);
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [subject7d, setSubject7d] = useState(
    data.templates.subject7d || DEFAULT_TEMPLATE_TEXTS["7d"].subject,
  );
  const [body7d, setBody7d] = useState(data.templates.body7d || DEFAULT_TEMPLATE_TEXTS["7d"].body);
  const [subject3d, setSubject3d] = useState(
    data.templates.subject3d || DEFAULT_TEMPLATE_TEXTS["3d"].subject,
  );
  const [body3d, setBody3d] = useState(data.templates.body3d || DEFAULT_TEMPLATE_TEXTS["3d"].body);

  const saving = fetcher.state !== "idle";
  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      if (fetcher.data.op === "saveConfig") setSavedBanner("Saved. The next nightly run will use this.");
      if (fetcher.data.op === "saveTemplates") setSavedBanner("Templates saved. They apply starting with the next send.");
    }
  }, [fetcher.state, fetcher.data]);

  const handleSaveConfig = useCallback(() => {
    setSavedBanner(null);
    fetcher.submit({ _action: "saveConfig", enabled: String(enabled) }, { method: "post" });
  }, [fetcher, enabled]);

  const handleSaveTemplates = useCallback(() => {
    setSavedBanner(null);
    fetcher.submit(
      { _action: "saveTemplates", subject7d, body7d, subject3d, body3d },
      { method: "post" },
    );
  }, [fetcher, subject7d, body7d, subject3d, body3d]);

  const handleResetTemplates = useCallback(() => {
    setSubject7d(DEFAULT_TEMPLATE_TEXTS["7d"].subject);
    setBody7d(DEFAULT_TEMPLATE_TEXTS["7d"].body);
    setSubject3d(DEFAULT_TEMPLATE_TEXTS["3d"].subject);
    setBody3d(DEFAULT_TEMPLATE_TEXTS["3d"].body);
    setSavedBanner(null);
    // Blank fields = null = built-in default (with the smart subject switch).
    fetcher.submit(
      { _action: "saveTemplates", subject7d: "", body7d: "", subject3d: "", body3d: "" },
      { method: "post" },
    );
  }, [fetcher]);

  const handleSuppress = useCallback(
    (reminderId: string) => {
      fetcher.submit({ _action: "suppress", reminderId }, { method: "post" });
    },
    [fetcher],
  );

  const tokenLegend = REMINDER_TEMPLATE_TOKENS.map((t) => `{${t.token}} = ${t.hint}`).join(" · ");

  return (
    <Page>
      <TitleBar title="Occasion Reminders" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {savedBanner ? (
              <Banner tone="success" onDismiss={() => setSavedBanner(null)}>
                {savedBanner}
              </Banner>
            ) : null}
            {actionError ? <Banner tone="critical">{actionError}</Banner> : null}
            {!data.emailConfigured ? (
              <Banner tone="warning">
                Email isn&apos;t configured. Reminders can&apos;t send.
              </Banner>
            ) : null}
            {!enabled ? (
              <Banner tone="info">
                Reminders are off. No emails will be sent.
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="150" blockAlign="center">
                  <Text as="h2" variant="headingMd">Performance</Text>
                  <InfoTip content="Converted = occasions where the customer ordered again after a reminder (checked nightly, up to 35 days after sending). Converted orders are also marked in each order's Delivery timeline on Orders Operations. ANNIV200 uses = store-wide redemptions of the code." />
                </InlineStack>
                <InlineStack gap="600" wrap>
                  <StatBlock label="Sent · 7-day" value={String(data.stats.sent7d)} />
                  <StatBlock label="Sent · 3-day" value={String(data.stats.sent3d)} />
                  <StatBlock label="Converted" value={String(data.stats.convertedOccasions)} />
                  <StatBlock
                    label="Conversion rate"
                    value={
                      data.stats.conversionRate === null ? "—" : `${data.stats.conversionRate}%`
                    }
                  />
                  <StatBlock
                    label={`${data.discountCode} uses`}
                    value={
                      data.stats.discountUsageCount === null
                        ? "—"
                        : String(data.stats.discountUsageCount)
                    }
                  />
                  <StatBlock label="Unsubscribed" value={String(data.suppressionCount)} />
                  <StatBlock label="Failed" value={String(data.stats.failedCount)} />
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Occasion reminder emails
                    </Text>
                    <InfoTip
                      content={`Emails go out 7 and 3 days before last year's occasion comes around again. The 3-day email carries ${data.discountCode} (${data.discountLabel}) and is skipped when the customer has already reordered. Repeats yearly until the customer unsubscribes.`}
                    />
                  </InlineStack>
                  <Badge tone={enabled ? "success" : "critical"}>
                    {enabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="Enable nightly reminder sends"
                  helpText="When off, no emails are sent."
                  checked={enabled}
                  onChange={setEnabled}
                />
                <InlineStack align="end">
                  <Button variant="primary" onClick={handleSaveConfig} loading={saving}>
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack gap="150" blockAlign="center">
                  <Text as="h2" variant="headingMd">Email templates</Text>
                  <InfoTip content={`Changes apply from the next send, no deploy needed. Variables: ${tokenLegend}`} />
                </InlineStack>
                <TemplateEditor
                  title="1st email · 7 days before"
                  tooltip='When the recipient and occasion are known, the built-in subject becomes personal ("Maria&apos;s anniversary is coming up"). A custom subject is always used as written.'
                  subject={subject7d}
                  body={body7d}
                  onSubject={setSubject7d}
                  onBody={setBody7d}
                  disabled={saving}
                />
                <Divider />
                <TemplateEditor
                  title="2nd email · 3 days before, with discount"
                  tooltip={`Carries ${data.discountCode} (${data.discountLabel}); skipped when the customer has already reordered. Keep the code active in Discounts.`}
                  subject={subject3d}
                  body={body3d}
                  onSubject={setSubject3d}
                  onBody={setBody3d}
                  disabled={saving}
                />
                <InlineStack align="end" gap="200">
                  <Button onClick={handleResetTemplates} disabled={saving}>
                    Reset to built-in default
                  </Button>
                  <Button variant="primary" onClick={handleSaveTemplates} loading={saving}>
                    Save templates
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Activity
                  </Text>
                  <Text as="span" tone="subdued" variant="bodySm">
                    {data.suppressionCount} unsubscribed
                  </Text>
                </InlineStack>
                {data.reminders.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No reminders yet. This fills up after the first nightly
                    scan.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {data.reminders.map((row: ReminderRowView) => {
                      const badge = statusBadge(row.status);
                      return (
                        <InlineStack
                          key={row.id}
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                          gap="200"
                        >
                          <BlockStack gap="050">
                            <InlineStack gap="200" blockAlign="center">
                              <Badge tone={badge.tone}>{badge.label}</Badge>
                              <Badge>{row.touch}</Badge>
                              {row.converted ? <Badge tone="success">Converted ✓</Badge> : null}
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {row.occasionDate}
                              </Text>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {row.occasionType}
                              </Text>
                            </InlineStack>
                            <Text as="span" tone="subdued" variant="bodySm">
                              {row.customerFirstName ?? "—"} · {row.customerEmail ?? "no email"}
                              {row.recipientName ? ` · for ${row.recipientName}` : ""}
                              {" · Order "}
                              {row.orderIdTail}
                            </Text>
                          </BlockStack>
                          {row.status !== "SUPPRESSED" && row.customerEmail ? (
                            <Button
                              size="slim"
                              tone="critical"
                              variant="tertiary"
                              onClick={() => handleSuppress(row.id)}
                              disabled={saving}
                            >
                              Suppress
                            </Button>
                          ) : null}
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
