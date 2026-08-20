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
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
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
    unsubscribeConfigured: Boolean(process.env.REMINDER_UNSUBSCRIBE_SECRET?.trim()),
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
          return { error: `${key}: lampas sa ${max} characters (${raw.length}).` };
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
      if (!reminderId) return { ok: false, op, error: "Walang reminder id." };
      const row = await prisma.occasionReminder.findUnique({ where: { id: reminderId } });
      if (!row || row.shop !== shop) {
        return { ok: false, op, error: "Hindi nahanap ang reminder." };
      }
      if (!row.customerEmail) {
        return { ok: false, op, error: "Walang email ang reminder na ito." };
      }
      await recordSuppression(shop, row.customerEmail, "all", "merchant");
      return { ok: true, op };
    }

    return { ok: false, op, error: "Hindi kilalang action." };
  } catch (error) {
    // ADR-11: never bubble a raw 5xx through the embedded fetcher.
    console.error("[reminders] action failed:", error);
    return { ok: false, op, error: "Nag-error — subukan ulit." };
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
      return { tone: "info", label: "Skipped — umorder na" };
    case "SUPPRESSED":
      return { tone: undefined, label: "Suppressed" };
    default:
      return { tone: undefined, label: status };
  }
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <Box minWidth="110px">
      <BlockStack gap="050">
        <Text as="p" variant="headingLg">{value}</Text>
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
      </BlockStack>
    </Box>
  );
}

function TemplateEditor({
  title,
  help,
  subject,
  body,
  onSubject,
  onBody,
  disabled,
}: {
  title: string;
  help: string;
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
      <Text as="h3" variant="headingSm">{title}</Text>
      <Text as="p" tone="subdued" variant="bodySm">{help}</Text>
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
        helpText="Awtomatikong idinadagdag ang unsubscribe footer sa dulo — hindi ito pwedeng matanggal."
      />
      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" fontWeight="semibold">
            Preview (sample data: si Juan → kay Maria, anniversary, Aug 25)
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
      if (fetcher.data.op === "saveConfig") setSavedBanner("Na-save na. Susundin ito ng susunod na nightly run.");
      if (fetcher.data.op === "saveTemplates") setSavedBanner("Na-save ang templates. Gagamitin na sa susunod na sends.");
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
                Hindi pa naka-configure ang SMTP email — walang reminder na
                maipapadala hangga&apos;t hindi ito naaayos.
              </Banner>
            ) : null}
            {!data.unsubscribeConfigured ? (
              <Banner tone="warning">
                Walang REMINDER_UNSUBSCRIBE_SECRET — naka-hold ang sends dahil
                bawal magpadala nang walang gumaganang unsubscribe link.
              </Banner>
            ) : null}
            {!enabled ? (
              <Banner tone="info">
                Nakapatay ang reminders — walang email na ipapadala. Buksan ang
                toggle sa baba kapag handa ka na.
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Performance</Text>
                <InlineStack gap="600" wrap>
                  <StatBlock label="7-day emails sent" value={String(data.stats.sent7d)} />
                  <StatBlock label="3-day emails sent" value={String(data.stats.sent3d)} />
                  <StatBlock
                    label="Converted (umorder ulit)"
                    value={String(data.stats.convertedOccasions)}
                  />
                  <StatBlock
                    label="Conversion rate"
                    value={
                      data.stats.conversionRate === null ? "—" : `${data.stats.conversionRate}%`
                    }
                  />
                  <StatBlock
                    label={`${data.discountCode} redemptions`}
                    value={
                      data.stats.discountUsageCount === null
                        ? "—"
                        : String(data.stats.discountUsageCount)
                    }
                  />
                  <StatBlock label="Unsubscribed" value={String(data.suppressionCount)} />
                  <StatBlock label="Failed" value={String(data.stats.failedCount)} />
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Ang &quot;Converted&quot; ay bawat okasyon kung saan umorder ulit ang customer
                  pagkatapos ma-email (chine-check gabi-gabi, hanggang 35 araw pagkatapos
                  ipadala). Ang {data.discountCode} count ay kabuuang redemptions ng code sa
                  buong store.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Occasion reminder emails
                  </Text>
                  <Badge tone={enabled ? "success" : "critical"}>
                    {enabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Awtomatikong nag-e-email sa mga customer 7 at 3 araw bago
                  maulit ang okasyon ng order nila noong nakaraang taon. Ang
                  3-day email ay may {data.discountLabel} code (
                  {data.discountCode}) at nila-laktawan kapag umorder na ulit
                  ang customer. Umuulit ito taon-taon hangga&apos;t hindi
                  nag-u-unsubscribe ang customer.
                </Text>
                <Checkbox
                  label="I-enable ang nightly reminder sends"
                  helpText="Kill switch ito — kapag naka-off, tumatakbo pa rin ang scan schedule pero walang email na aalis."
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
                <Text as="h2" variant="headingMd">Email templates</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  I-edit ang subject at body ng dalawang email — gagamitin agad
                  sa susunod na sends, walang deploy na kailangan. Mga variable
                  na pwedeng gamitin: {tokenLegend}
                </Text>
                <TemplateEditor
                  title="1st email — 7 araw bago ang okasyon"
                  help='Kapag kilala ang recipient AT ang okasyon, awtomatikong nagiging mas personal ang built-in subject ("Maria&apos;s anniversary is coming up"). Kapag ni-customize mo ang subject dito, ang tekstong ito na ang laging gagamitin.'
                  subject={subject7d}
                  body={body7d}
                  onSubject={setSubject7d}
                  onBody={setBody7d}
                  disabled={saving}
                />
                <Divider />
                <TemplateEditor
                  title="2nd email — 3 araw bago (may discount, ni-la-laktawan kapag umorder na)"
                  help={`Dito nakalagay ang ${data.discountCode} (${data.discountLabel}). Siguraduhing aktibo ang code sa Discounts bago ito ipangako.`}
                  subject={subject3d}
                  body={body3d}
                  onSubject={setSubject3d}
                  onBody={setBody3d}
                  disabled={saving}
                />
                <InlineStack align="end" gap="200">
                  <Button onClick={handleResetTemplates} disabled={saving}>
                    Balik sa built-in default
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
                    {data.suppressionCount} naka-unsubscribe
                  </Text>
                </InlineStack>
                {data.reminders.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Wala pang reminder — mapupuno ito pagkatapos ng unang
                    nightly scan.
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
                              {row.customerFirstName ?? "—"} · {row.customerEmail ?? "walang email"}
                              {row.recipientName ? ` · para kay ${row.recipientName}` : ""}
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
