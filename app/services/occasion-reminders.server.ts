// Occasion reminder emails — nightly scan + auto-send (merchant decisions
// 2026-08-20/21: fully automatic, touches at 7 and 3 days before the
// occasion, ALL orders enter the calendar, recurring yearly).
//
// ZERO Shopify order writes: this service only ever runs read-only Admin
// GraphQL queries (orders search). Its writes are Postgres-side only
// (OccasionReminder / ReminderSuppression / EmailSendLog rows) — same
// side-table posture as the sendEmail op, outside the docs/api.md §2 order
// write-path contract. The read-only guard test greps this file.
//
// Yearly recurrence design: the Shopify search only ever looks ONE year back
// (Source A). Older occasions roll forward from our own SENT rows (Source B),
// so the chain lives in Postgres and the search cost never grows with age.

import crypto from "node:crypto";

import prisma from "../db.server";
import {
  addDaysISO,
  detectOccasion,
  excerptCardMessage,
  isSameOccasionDate,
  nextOccurrence,
} from "./occasion-detection.server";
import {
  appendReminderFooter,
  buildReminderDraft,
  type ReminderTouch,
} from "./reminder-copy.server";
import { sendCustomerEmail } from "./send-customer-email.server";
import type { AdminGraphQLClient } from "./delivery-bookings.server";
import { getShopLocalDate } from "../lib/delivery-availability";

export const TOUCH_OFFSETS: Array<{ touch: ReminderTouch; days: number }> = [
  { touch: "7d", days: 7 },
  { touch: "3d", days: 3 },
];
// Each nightly run covers occasion dates [today+offset, today+offset+WINDOW-1]
// so up to WINDOW-1 missed nights still catch every occasion (the unique
// constraint dedupes the overlap).
export const SCAN_WINDOW_DAYS = 3;
// Orders are placed up to ~45 days before their delivery date; the created_at
// search window stretches back this far past the target delivery window.
const CREATED_AT_BACK_BUFFER_DAYS = 45;
const ORDER_PAGE_SIZE = 250;
const MAX_PAGES = 5;
export const MAX_SENDS_PER_RUN = 50;
const MAX_SEND_ATTEMPTS = 3;

const DEFAULT_TIMEZONE = "Asia/Manila";
const DEFAULT_CUTOFF_HOUR = 14;

export const REMINDER_STATUS = {
  pending: "PENDING",
  sent: "SENT",
  suppressed: "SUPPRESSED",
  failed: "FAILED",
  skippedReordered: "SKIPPED_REORDERED",
} as const;

// ─── Unsubscribe tokens ───────────────────────────────────────────────────────

interface UnsubscribePayload {
  email: string;
  scope: string; // "all" (footer link) | "order:<id>" (kept for future use)
}

function unsubscribeSecret(): string {
  return process.env.REMINDER_UNSUBSCRIBE_SECRET?.trim() ?? "";
}

export function makeUnsubscribeToken(payload: UnsubscribePayload): string | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  const json = JSON.stringify({ email: payload.email.toLowerCase(), scope: payload.scope });
  const body = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(json).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let json: string;
  try {
    json = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", secret).update(json).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as Partial<UnsubscribePayload>;
    if (typeof parsed.email !== "string" || typeof parsed.scope !== "string") return null;
    return { email: parsed.email.toLowerCase(), scope: parsed.scope };
  } catch {
    return null;
  }
}

function unsubscribeUrl(email: string): string | null {
  const base = process.env.SHOPIFY_APP_URL?.trim()?.replace(/\/+$/, "");
  const token = makeUnsubscribeToken({ email, scope: "all" });
  if (!base || !token) return null;
  return `${base}/public/reminder-unsubscribe?token=${encodeURIComponent(token)}`;
}

// ─── Suppression ──────────────────────────────────────────────────────────────

export async function isSuppressed(
  shop: string,
  email: string,
  shopifyOrderId: string,
): Promise<boolean> {
  const row = await prisma.reminderSuppression.findFirst({
    where: {
      shop,
      email: email.toLowerCase(),
      scope: { in: ["all", `order:${shopifyOrderId}`] },
    },
    select: { id: true },
  });
  return Boolean(row);
}

export async function recordSuppression(
  shop: string,
  email: string,
  scope: string,
  source: string,
): Promise<void> {
  const normalized = email.toLowerCase();
  await prisma.reminderSuppression.upsert({
    where: { shop_email_scope: { shop, email: normalized, scope } },
    update: {},
    create: { shop, email: normalized, scope, source },
  });
  await prisma.occasionReminder.updateMany({
    where: {
      shop,
      status: REMINDER_STATUS.pending,
      customerEmail: { equals: normalized, mode: "insensitive" },
      ...(scope.startsWith("order:") ? { shopifyOrderId: scope.slice("order:".length) } : {}),
    },
    data: { status: REMINDER_STATUS.suppressed },
  });
}

// ─── Source A: last-year orders via Admin GraphQL ─────────────────────────────

const ORDERS_SCAN_QUERY = `#graphql
  query OccasionReminderScan($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          name
          note
          cancelledAt
          customAttributes {
            key
            value
          }
          customer {
            firstName
            defaultEmailAddress {
              emailAddress
              marketingState
            }
          }
          billingAddress {
            firstName
            name
          }
          shippingAddress {
            firstName
            name
          }
          deliveryDateMetafield: metafield(namespace: "custom", key: "date") {
            value
          }
          fulfillments(first: 5) {
            deliveredAt
          }
          lineItems(first: 3) {
            edges {
              node {
                title
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const REORDER_CHECK_QUERY = `#graphql
  query OccasionReminderReorderCheck($query: String!) {
    orders(first: 1, query: $query) {
      edges {
        node {
          id
        }
      }
    }
  }
`;

interface ScanOrderNode {
  id: string;
  name?: string | null;
  note?: string | null;
  cancelledAt?: string | null;
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
  customer?: {
    firstName?: string | null;
    defaultEmailAddress?: { emailAddress?: string | null; marketingState?: string | null } | null;
  } | null;
  billingAddress?: { firstName?: string | null; name?: string | null } | null;
  shippingAddress?: { firstName?: string | null; name?: string | null } | null;
  deliveryDateMetafield?: { value?: string | null } | null;
  fulfillments?: Array<{ deliveredAt?: string | null }> | null;
  lineItems?: { edges?: Array<{ node?: { title?: string | null } | null }> | null } | null;
}

async function parseGraphQLJson(resp: Response): Promise<Record<string, unknown>> {
  const json = (await resp.json()) as Record<string, unknown>;
  const errors = json.errors;
  if (errors) {
    const message = Array.isArray(errors)
      ? errors.map((e) => (e as { message?: string }).message ?? "unknown").join("; ")
      : String(errors);
    throw new Error(`Admin GraphQL error: ${message}`);
  }
  return json;
}

function firstWord(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
}

// Greeting: billing name first, fallback shipping, then the customer record
// (merchant decision 2026-08-21).
function resolveGreetingName(node: ScanOrderNode): string | null {
  return (
    firstWord(node.billingAddress?.firstName) ??
    firstWord(node.billingAddress?.name) ??
    firstWord(node.shippingAddress?.firstName) ??
    firstWord(node.shippingAddress?.name) ??
    firstWord(node.customer?.firstName)
  );
}

// Recipient: the shipping/delivery name from the order details — NEVER parsed
// from the card message (merchant measured ~70% parse failure). A recipient
// identical to the greeting name (self-orders) is treated as unknown so the
// copy falls back to "someone special" instead of "you sent flowers to Juan"
// addressed to Juan.
function resolveRecipientName(node: ScanOrderNode, greeting: string | null): string | null {
  const recipient =
    firstWord(node.shippingAddress?.firstName) ?? firstWord(node.shippingAddress?.name);
  if (!recipient) return null;
  if (greeting && recipient.toLowerCase() === greeting.toLowerCase()) return null;
  return recipient;
}

function findAttr(node: ScanOrderNode, ...keys: string[]): string | null {
  const attrs = node.customAttributes ?? [];
  for (const key of keys) {
    const hit = attrs.find((a) => (a.key ?? "").toLowerCase() === key.toLowerCase());
    const value = hit?.value?.trim();
    if (value) return value;
  }
  return null;
}

function earliestDeliveredAt(node: ScanOrderNode): string | null {
  const stamps = (node.fulfillments ?? [])
    .map((f) => f.deliveredAt)
    .filter((v): v is string => Boolean(v) && !Number.isNaN(Date.parse(v!)));
  if (stamps.length === 0) return null;
  return stamps.sort((a, b) => Date.parse(a) - Date.parse(b))[0].slice(0, 10);
}

function productTitles(node: ScanOrderNode): string | null {
  const titles = (node.lineItems?.edges ?? [])
    .map((e) => e?.node?.title?.trim())
    .filter((t): t is string => Boolean(t))
    .slice(0, 2);
  if (titles.length === 0) return null;
  return titles.join(" and ");
}

// Shopify search values are double-quoted; reject emails that would break out
// of the quotes rather than trying to escape them (same posture as the
// Sidekick order-name sanitizer).
function safeSearchValue(value: string): string | null {
  if (/["\\]/.test(value)) return null;
  return `"${value}"`;
}

interface ReminderCandidate {
  source: "order" | "rollforward";
  shopifyOrderId: string;
  occasionDate: string; // upcoming ISO date
  occasionYear: number;
  occasionType: string;
  detectSource: string;
  customerEmail: string | null;
  marketingState: string | null; // Source A only; roll-forward trusts our suppression list
  customerFirstName: string | null;
  recipientName: string | null;
  cardMessageExcerpt: string | null;
  productTitles: string | null;
  priorYearsSent: number;
}

// ─── The nightly run ──────────────────────────────────────────────────────────

export interface ReminderScanSummary {
  ok: boolean;
  disabled?: boolean;
  error?: string;
  scanned: number;
  created: number;
  sent: number;
  skippedConsent: number;
  skippedSuppressed: number;
  skippedNoEmail: number;
  skippedExisting: number;
  skippedDuplicateOccasion: number;
  skippedReordered: number;
  failed: number;
  truncated: boolean;
}

function emptySummary(): ReminderScanSummary {
  return {
    ok: true,
    scanned: 0,
    created: 0,
    sent: 0,
    skippedConsent: 0,
    skippedSuppressed: 0,
    skippedNoEmail: 0,
    skippedExisting: 0,
    skippedDuplicateOccasion: 0,
    skippedReordered: 0,
    failed: 0,
    truncated: false,
  };
}

export async function runReminderScan(options: {
  admin: AdminGraphQLClient;
  shop: string;
  touchOffsetsOverride?: Array<{ touch: ReminderTouch; days: number }>;
  windowDaysOverride?: number;
  now?: Date;
}): Promise<ReminderScanSummary> {
  const { admin, shop } = options;
  const summary = emptySummary();

  const config = await prisma.reminderConfig.findUnique({ where: { shop } });
  if (!config?.enabled) {
    return { ...summary, disabled: true };
  }

  const scheduleConfig = await prisma.deliveryScheduleConfig.findUnique({
    where: { shop },
    select: { timezone: true, cutoffHour: true },
  });
  const timezone = scheduleConfig?.timezone || DEFAULT_TIMEZONE;
  const cutoffHour = scheduleConfig?.cutoffHour ?? DEFAULT_CUTOFF_HOUR;
  const today = getShopLocalDate(timezone, options.now ?? new Date());
  if (!today) {
    return { ...summary, ok: false, error: "could not resolve shop-local date" };
  }

  const touches = options.touchOffsetsOverride ?? TOUCH_OFFSETS;
  const windowDays = options.windowDaysOverride ?? SCAN_WINDOW_DAYS;

  // Target occasion-date windows per touch, plus the combined range that one
  // Shopify search can cover for both.
  const touchWindows = touches.map(({ touch, days }) => ({
    touch,
    start: addDaysISO(today, days),
    end: addDaysISO(today, days + windowDays - 1),
  }));
  const combinedStart = touchWindows.reduce(
    (min, w) => (w.start < min ? w.start : min),
    touchWindows[0].start,
  );
  const combinedEnd = touchWindows.reduce(
    (max, w) => (w.end > max ? w.end : max),
    touchWindows[0].end,
  );

  // ── Source A: orders delivered in the same window one year ago ──
  const lastYearStart = minusOneYear(combinedStart);
  const lastYearEnd = minusOneYear(combinedEnd);
  const searchQuery =
    `created_at:>=${addDaysISO(lastYearStart, -CREATED_AT_BACK_BUFFER_DAYS)} ` +
    `created_at:<=${addDaysISO(lastYearEnd, 1)} -status:cancelled`;

  const candidates: ReminderCandidate[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await admin.graphql(ORDERS_SCAN_QUERY, {
      variables: { first: ORDER_PAGE_SIZE, after, query: searchQuery },
    });
    const json = await parseGraphQLJson(resp);
    const orders = (json.data as {
      orders?: {
        edges?: Array<{ node?: ScanOrderNode }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    })?.orders;
    const edges = orders?.edges ?? [];

    for (const edge of edges) {
      const node = edge.node;
      if (!node?.id || node.cancelledAt) continue;
      summary.scanned++;

      const baseDate =
        node.deliveryDateMetafield?.value?.trim() || earliestDeliveredAt(node);
      if (!baseDate || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) continue;
      if (baseDate < lastYearStart || baseDate > lastYearEnd) continue;

      const upcoming = nextOccurrence(baseDate, today);
      if (!upcoming) continue;

      const cardMessage = findAttr(node, "Card Message", "card_message");
      const detection = detectOccasion(cardMessage, node.note);
      const greeting = resolveGreetingName(node);

      candidates.push({
        source: "order",
        shopifyOrderId: node.id,
        occasionDate: upcoming.date,
        occasionYear: upcoming.year,
        occasionType: detection?.type ?? "generic",
        detectSource: detection?.source ?? "none",
        customerEmail: node.customer?.defaultEmailAddress?.emailAddress?.trim() || null,
        marketingState: node.customer?.defaultEmailAddress?.marketingState ?? null,
        customerFirstName: greeting,
        recipientName: resolveRecipientName(node, greeting),
        cardMessageExcerpt: excerptCardMessage(cardMessage),
        productTitles: productTitles(node),
        priorYearsSent: 0,
      });
    }

    if (!orders?.pageInfo?.hasNextPage) break;
    after = orders.pageInfo.endCursor ?? null;
    if (page === MAX_PAGES - 1) summary.truncated = true;
  }

  // ── Source B: roll last year's SENT chains forward one year ──
  const priorRows = await prisma.occasionReminder.findMany({
    where: {
      shop,
      touch: "7d",
      status: REMINDER_STATUS.sent,
      occasionDate: {
        gte: isoToDate(minusOneYear(combinedStart)),
        lte: isoToDate(minusOneYear(combinedEnd)),
      },
    },
  });
  for (const row of priorRows) {
    const priorISO = dateToISO(row.occasionDate);
    const upcoming = nextOccurrence(priorISO, today);
    if (!upcoming) continue;
    candidates.push({
      source: "rollforward",
      shopifyOrderId: row.shopifyOrderId,
      occasionDate: upcoming.date,
      occasionYear: upcoming.year,
      occasionType: row.occasionType,
      detectSource: row.detectSource,
      customerEmail: row.customerEmail,
      marketingState: null,
      customerFirstName: row.customerFirstName,
      recipientName: row.recipientHint,
      cardMessageExcerpt: row.cardMessageExcerpt,
      productTitles: row.productTitles,
      priorYearsSent: row.priorYearsSent + 1,
    });
  }

  // ── Cross-source dedupe: one occasion per (email, month-day) per year.
  // A fresh re-order (Source A) replaces the old chain (Source B). ──
  const kept: ReminderCandidate[] = [];
  const ordered = [...candidates].sort((a, b) =>
    a.source === b.source ? 0 : a.source === "order" ? -1 : 1,
  );
  for (const candidate of ordered) {
    const email = candidate.customerEmail?.toLowerCase();
    const duplicate =
      email &&
      kept.some(
        (k) =>
          k.customerEmail?.toLowerCase() === email &&
          isSameOccasionDate(k.occasionDate, candidate.occasionDate),
      );
    if (duplicate) {
      summary.skippedDuplicateOccasion++;
      continue;
    }
    kept.push(candidate);
  }

  // ── Create PENDING rows (idempotent via the unique constraint) ──
  for (const candidate of kept) {
    for (const window of touchWindows) {
      if (candidate.occasionDate < window.start || candidate.occasionDate > window.end) continue;
      try {
        if (!candidate.customerEmail) {
          summary.skippedNoEmail++;
          continue;
        }
        if (candidate.marketingState === "UNSUBSCRIBED") {
          summary.skippedConsent++;
          continue;
        }
        if (await isSuppressed(shop, candidate.customerEmail, candidate.shopifyOrderId)) {
          summary.skippedSuppressed++;
          continue;
        }
        await prisma.occasionReminder.create({
          data: {
            shop,
            shopifyOrderId: candidate.shopifyOrderId,
            occasionDate: isoToDate(candidate.occasionDate),
            occasionYear: candidate.occasionYear,
            occasionType: candidate.occasionType,
            touch: window.touch,
            detectSource: candidate.detectSource,
            customerEmail: candidate.customerEmail,
            customerFirstName: candidate.customerFirstName,
            recipientHint: candidate.recipientName,
            cardMessageExcerpt: candidate.cardMessageExcerpt,
            productTitles: candidate.productTitles,
            priorYearsSent: candidate.priorYearsSent,
          },
        });
        summary.created++;
      } catch (error) {
        if (isUniqueViolation(error)) {
          summary.skippedExisting++;
        } else {
          summary.failed++;
          console.warn(
            `[reminder-scan] create failed for ${candidate.shopifyOrderId}/${window.touch}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  // ── Send phase: every due PENDING row (includes retries from prior nights) ──
  const pendingRows = await prisma.occasionReminder.findMany({
    where: {
      shop,
      status: REMINDER_STATUS.pending,
      attemptCount: { lt: MAX_SEND_ATTEMPTS },
      occasionDate: { gte: isoToDate(today) },
    },
    orderBy: { occasionDate: "asc" },
    take: MAX_SENDS_PER_RUN,
  });

  for (const row of pendingRows) {
    // One row's failure must never abort the rest of the batch.
    try {
      const email = row.customerEmail;
      if (!email) {
        await prisma.occasionReminder.update({
          where: { id: row.id },
          data: { status: REMINDER_STATUS.failed },
        });
        summary.skippedNoEmail++;
        continue;
      }

      // Suppression re-check at send time — an unsubscribe that landed after
      // the scan (or after the 7d send) must stop this email.
      if (await isSuppressed(shop, email, row.shopifyOrderId)) {
        await prisma.occasionReminder.update({
          where: { id: row.id },
          data: { status: REMINDER_STATUS.suppressed },
        });
        summary.skippedSuppressed++;
        continue;
      }

      // Merchant's 2nd-email logic (2026-08-21): before the 3d email, check
      // whether this customer has ordered since the 1st email went out — if
      // yes, the 2nd email does not send.
      if (row.touch === "3d") {
        const sibling = await prisma.occasionReminder.findUnique({
          where: {
            shop_shopifyOrderId_occasionYear_touch: {
              shop,
              shopifyOrderId: row.shopifyOrderId,
              occasionYear: row.occasionYear,
              touch: "7d",
            },
          },
          select: { sentAt: true },
        });
        const since = sibling?.sentAt ?? row.suggestedAt;
        if (await hasOrderedSince(admin, email, since)) {
          await prisma.occasionReminder.update({
            where: { id: row.id },
            data: { status: REMINDER_STATUS.skippedReordered },
          });
          summary.skippedReordered++;
          continue;
        }
      }

      const optOutUrl = unsubscribeUrl(email);
      if (!optOutUrl) {
        // No unsubscribe link possible (missing secret/app URL) → refuse to
        // send rather than send an email the customer cannot opt out of.
        summary.failed++;
        console.warn("[reminder-scan] REMINDER_UNSUBSCRIBE_SECRET or SHOPIFY_APP_URL missing — sends held");
        break;
      }

      const draft = buildReminderDraft({
        touch: row.touch as ReminderTouch,
        occasionType: row.occasionType,
        occasionDate: dateToISO(row.occasionDate),
        customerFirstName: row.customerFirstName,
        recipientName: row.recipientHint,
        productTitles: row.productTitles,
        cutoffHour,
      });
      const body = appendReminderFooter(draft.body, optOutUrl);

      const result = await sendCustomerEmail({ to: email, subject: draft.subject, textBody: body });
      if (result.ok) {
        await prisma.occasionReminder.update({
          where: { id: row.id },
          data: { status: REMINDER_STATUS.sent, sentAt: new Date() },
        });
        summary.sent++;
        // Guarded audit write — surfaces in the order panel's DeliveryTimeline.
        try {
          await prisma.emailSendLog.create({
            data: { shop, shopifyOrderId: row.shopifyOrderId, to: email, subject: draft.subject },
          });
        } catch (error) {
          console.warn(
            `[reminder-scan] EmailSendLog write failed for ${row.shopifyOrderId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        const attempts = row.attemptCount + 1;
        await prisma.occasionReminder.update({
          where: { id: row.id },
          data: {
            attemptCount: attempts,
            ...(attempts >= MAX_SEND_ATTEMPTS ? { status: REMINDER_STATUS.failed } : {}),
          },
        });
        summary.failed++;
        console.warn(`[reminder-scan] send failed for ${row.shopifyOrderId}/${row.touch}: ${result.error}`);
      }
    } catch (error) {
      summary.failed++;
      console.warn(
        `[reminder-scan] row ${row.id} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return summary;
}

// Did this customer place any (non-cancelled) order since `since`? Uses the
// orders email: search filter — a read-only query.
async function hasOrderedSince(
  admin: AdminGraphQLClient,
  email: string,
  since: Date,
): Promise<boolean> {
  const quoted = safeSearchValue(email);
  if (!quoted) return false;
  const sinceISO = since.toISOString();
  const resp = await admin.graphql(REORDER_CHECK_QUERY, {
    variables: { query: `email:${quoted} created_at:>=${sinceISO} -status:cancelled` },
  });
  const json = await parseGraphQLJson(resp);
  const edges = (json.data as { orders?: { edges?: unknown[] } })?.orders?.edges ?? [];
  return edges.length > 0;
}

// ─── Small date helpers (DATE column ↔ ISO string) ───────────────────────────

function minusOneYear(dateISO: string): string {
  const [year, month, day] = dateISO.split("-");
  if (month === "02" && day === "29") return `${Number(year) - 1}-02-28`;
  return `${Number(year) - 1}-${month}-${day}`;
}

function isoToDate(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00.000Z`);
}

function dateToISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}
