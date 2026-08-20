// Reminders — kill switch + activity feed for the occasion reminder emails
// (the nightly auto-send in services/occasion-reminders.server.ts). Writes:
//   - ReminderConfig.enabled (the kill switch),
//   - ReminderSuppression rows (the merchant "Suppress" escape hatch, which
//     also flips that email's PENDING rows to SUPPRESSED).
// Postgres only — ZERO Shopify writes; none of this touches delivery state
// (see api.md §2 vicinity note). Per ADR-11, the action always answers
// 200 + { ok, ... }.

import { useCallback, useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Page,
  Text,
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

const ACTIVITY_LIMIT = 50;

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
}

export const loader = async ({ request }: { request: Request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, rows, suppressionCount] = await Promise.all([
    prisma.reminderConfig.findUnique({ where: { shop } }),
    prisma.occasionReminder.findMany({
      where: { shop },
      orderBy: [{ updatedAt: "desc" }],
      take: ACTIVITY_LIMIT,
    }),
    prisma.reminderSuppression.count({ where: { shop } }),
  ]);

  return {
    enabled: config?.enabled ?? false,
    emailConfigured: Boolean(
      process.env.EMAIL_SMTP_USER?.trim() && process.env.EMAIL_SMTP_PASSWORD?.trim(),
    ),
    unsubscribeConfigured: Boolean(process.env.REMINDER_UNSUBSCRIBE_SECRET?.trim()),
    suppressionCount,
    discountCode: REMINDER_DISCOUNT_CODE,
    discountLabel: REMINDER_DISCOUNT_LABEL,
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

export default function RemindersPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [enabled, setEnabled] = useState(data.enabled);
  const [savedBanner, setSavedBanner] = useState(false);

  const saving = fetcher.state !== "idle";
  const actionError = fetcher.data?.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.op === "saveConfig") {
      setSavedBanner(true);
    }
  }, [fetcher.state, fetcher.data]);

  const handleSave = useCallback(() => {
    setSavedBanner(false);
    fetcher.submit({ _action: "saveConfig", enabled: String(enabled) }, { method: "post" });
  }, [fetcher, enabled]);

  const handleSuppress = useCallback(
    (reminderId: string) => {
      fetcher.submit({ _action: "suppress", reminderId }, { method: "post" });
    },
    [fetcher],
  );

  return (
    <Page>
      <TitleBar title="Occasion Reminders" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {savedBanner ? (
              <Banner tone="success" onDismiss={() => setSavedBanner(false)}>
                Na-save na. Susundin ito ng susunod na nightly run.
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
                  <Button variant="primary" onClick={handleSave} loading={saving}>
                    Save
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
