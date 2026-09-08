import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from "react";

// Lazy-loaded: the panel only mounts when a merchant opens an order, so it
// ships as a separate chunk off the initial bundle.
const OrderDetailsPanel = lazy(() =>
  import("../components/orders/OrderDetailsPanel").then((m) => ({
    default: m.OrderDetailsPanel,
  })),
);
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import {
  type Order,
  toLocalISODate,
  normalizeDateToISO,
  isUnpaidStatus,
  getMeaningfulTags,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  formatDeliveryDate,
} from "../lib/order-utils";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useNavigation,
  useFetcher,
  useFetchers,
} from "react-router";
import type { RescheduleTarget } from "../components/orders/RescheduleModal";
import type { RescheduleRulesData } from "./app.orders_.reschedule-rules";
import { useBulkActions } from "../hooks/useBulkActions";
import { useSmartRefresh } from "../hooks/useSmartRefresh";
import { useOrdersDiff } from "../hooks/useOrdersDiff";
import {
  OrdersIndexTable,
  type OrdersTabDef,
} from "../components/orders/OrdersIndexTable";
import { CancelModal } from "../components/orders/CancelModal";
import { ArchiveModal } from "../components/orders/ArchiveModal";
import { UnarchiveModal } from "../components/orders/UnarchiveModal";
import { AddTagsModal } from "../components/orders/AddTagsModal";
import { RemoveTagsModal } from "../components/orders/RemoveTagsModal";
import { SharedTagsModal } from "../components/orders/SharedTagsModal";
import { KpiProductsModal } from "../components/orders/KpiProductsModal";
import { MarkFulfilledModal } from "../components/orders/MarkFulfilledModal";
import { RescheduleModal } from "../components/orders/RescheduleModal";
import { SendEmailModal } from "../components/orders/SendEmailModal";
import { EditDetailsModal } from "../components/orders/EditDetailsModal";
import { RecentReschedulesBanner } from "../components/orders/RecentReschedulesBanner";
import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  getShopLocalDate,
  validateMerchantRescheduleSelection,
} from "../lib/delivery-availability";
import { slotValuesMatch } from "../lib/slot-value";
import {
  type RecentRescheduleItem,
  buildRecentRescheduleSearchQuery,
  rescheduleBadgeLabel,
  selectRecentReschedules,
} from "../lib/recent-reschedules";
import { handleSendEmailOp } from "../services/send-customer-email.server";
import { handleEditDetailsOp } from "../services/update-order-contact.server";
import { handleMarkRescheduleSeenOp } from "../services/reschedule-seen.server";
import type { AdminGraphQLClient } from "../services/order-delivery-metafields.server";
import {
  getDeliverySyncIssues,
  retryDeliverySyncIssues,
  type DeliverySyncIssueSummary,
} from "../services/delivery-sync-task.server";
import {
  BULK_INLINE_MAX,
  MAX_SELECTED_ORDER_IDS,
  executeBulkAction,
  fetchRescheduleOrderStates,
  isBulkActionName,
  rescheduleCurrentDateOf,
  rescheduleCurrentSlotOf,
  type BulkActionItemResult,
  type BulkActionName,
  type BulkActionResponse,
  type BulkOpParams,
} from "../services/bulk-actions.server";
import {
  createBulkActionJob,
  runBulkJobToCompletion,
} from "../services/bulk-action-jobs.server";
import { enqueueBulkActionTask } from "../services/ops-queue.server";
import prisma from "../db.server";
import {
  getScheduleRules,
  getScheduleRulesWithBookedCounts,
} from "../services/schedule-rules.server";
import {
  MAX_ORDER_TAG_LENGTH,
  buildDeliveryDateTagQuery,
} from "../lib/order-tags";
import { computeDateRefs, enumerateISODates } from "../lib/date-refs";
import { authenticate } from "../shopify.server";
import panelStylesHref from "../styles/order-details-panel.css?url";

export const links = () => [{ rel: "stylesheet", href: panelStylesHref }];

// Opening/closing the details panel only toggles the ?order search param, and
// the panel reads its order from already-loaded data — skip the loader re-run
// for that navigation (REC-7). Everything else (filter/tab/cursor changes,
// post-action revalidation, useRevalidator) keeps the default behavior.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: {
  currentUrl: URL;
  nextUrl: URL;
  formMethod?: string;
  defaultShouldRevalidate: boolean;
}) {
  if (formMethod && formMethod.toUpperCase() !== "GET") {
    return defaultShouldRevalidate;
  }
  if (
    currentUrl.pathname !== nextUrl.pathname ||
    currentUrl.search === nextUrl.search
  ) {
    return defaultShouldRevalidate;
  }
  const current = new URLSearchParams(currentUrl.search);
  const next = new URLSearchParams(nextUrl.search);
  current.delete("order");
  next.delete("order");
  current.sort();
  next.sort();
  if (current.toString() === next.toString()) {
    return false;
  }
  return defaultShouldRevalidate;
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

// ─── GraphQL Query ────────────────────────────────────────────────────────────

const GET_ORDERS_QUERY = `
  query GetOrdersTable(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $query: String
    $reverse: Boolean!
  ) {
    orders(
      first: $first
      after: $after
      last: $last
      before: $before
      query: $query
      sortKey: CREATED_AT
      reverse: $reverse
    ) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          statusPageUrl
          tags
          note
          customer {
            id
            firstName
            lastName
            numberOfOrders
            defaultEmailAddress {
              emailAddress
            }
            defaultPhoneNumber {
              phoneNumber
            }
          }
          shippingAddress {
            address1
            address2
            city
            province
            zip
            country
            phone
            # Carry-forward fields for the editDetails op: OrderInput's
            # shippingAddress OVERWRITES, so a save that omits these nulls the
            # recipient name / company / region on the address. Read here so
            # the modal can show what it is about to preserve.
            firstName
            lastName
            company
            provinceCode
            countryCodeV2
          }
          billingAddress {
            name
            address1
            phone
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customAttributes {
            key
            value
          }
          deliveryDate: metafield(namespace: "delivery", key: "date") {
            value
          }
          deliveryTimeSlot: metafield(namespace: "delivery", key: "time_slot") {
            value
          }
          customDate: metafield(namespace: "custom", key: "date") {
            value
          }
          customTimeSlot: metafield(namespace: "custom", key: "time_slot") {
            value
          }
          rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
            value
            jsonValue
          }
          rescheduleStatus: metafield(namespace: "$app", key: "reschedule_status") {
            value
          }
          fulfillments(first: 5) {
            createdAt
            deliveredAt
          }
          lineItems(first: 10) {
            edges {
              node {
                name
                quantity
                sku
                image {
                  url
                  altText
                }
                product {
                  title
                  featuredImage {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

// ─── Recent reschedules (the "Rescheduled today" banner, 2026-09-04) ──────────
//
// A second, small query per load: orders tagged `resched-<day>` for the last
// three shop-local days (query string built in lib/recent-reschedules). It is
// separate from GET_ORDERS_QUERY on purpose — the banner must show on EVERY
// tab, and the rescheduled order has usually just left the tab being viewed.
const RECENT_RESCHEDULE_PAGE = 50;

const GET_RECENT_RESCHEDULES_QUERY = `
  query GetRecentReschedules($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          legacyResourceId
          name
          tags
          customer {
            id
            firstName
            lastName
            numberOfOrders
            defaultEmailAddress {
              emailAddress
            }
            defaultPhoneNumber {
              phoneNumber
            }
          }
          customAttributes {
            key
            value
          }
          customDate: metafield(namespace: "custom", key: "date") {
            value
          }
          customTimeSlot: metafield(namespace: "custom", key: "time_slot") {
            value
          }
          rescheduleHistory: metafield(namespace: "delivery", key: "reschedule_history") {
            value
            jsonValue
          }
          rescheduleSeenAt: metafield(namespace: "$app", key: "reschedule_seen_at") {
            value
          }
        }
      }
    }
  }
`;

// Banner garnish, never page-critical: every failure degrades to "no banner".
async function fetchRecentRescheduleOrders(
  admin: AdminGraphQLClient,
  todayISO: string,
): Promise<Order[]> {
  const query = buildRecentRescheduleSearchQuery(todayISO);
  if (!query) return [];
  try {
    const response = await admin.graphql(GET_RECENT_RESCHEDULES_QUERY, {
      variables: { first: RECENT_RESCHEDULE_PAGE, query },
    });
    const body = (await response.json()) as {
      data?: { orders?: { edges?: Array<{ node: Order }> } };
      errors?: Array<{ message: string }>;
    };
    if (body.errors?.length) {
      console.warn(
        `[orders loader] recent reschedules skipped: ${body.errors
          .map((e) => e.message)
          .join("; ")}`,
      );
      return [];
    }
    return body.data?.orders?.edges?.map((edge) => edge.node) ?? [];
  } catch (error) {
    console.warn(
      `[orders loader] recent reschedules skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

// ─── Runtime safety helpers ───────────────────────────────────────────────────

function isIsoDateParam(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHttpTrackingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Sort options (IndexFilters). Only the CREATED_AT direction is server-side —
// the Admin API has no metafield sort key, so the deliveryDate options keep
// the server default order and are sorted client-side on the loaded page.
const SORT_PARAM_VALUES = new Set([
  "orderDate asc",
  "orderDate desc",
  "deliveryDate asc",
  "deliveryDate desc",
]);
const DEFAULT_SORT = "orderDate desc";

// ─── Loader ───────────────────────────────────────────────────────────────────

type LoaderData = {
  orders: Order[];
  pageInfo: PageInfo | null;
  errors: Array<{ message: string }> | null;
  deliveryDateParam: string | null;
  searchParam: string;
  timeWindowParam: string;
  tabParam: string;
  sortParam: string;
  /**
   * SHOP-local "today" (YYYY-MM-DD), stamped fresh on every loader run — the
   * client's date tabs / overdue chips derive from this, never from the
   * browser clock, so a merchant (or VA) on a non-Manila machine and a page
   * left open past shop midnight both still see the shop's real "Today".
   */
  todayISO: string;
  /** Orders page size this load used (25 or 250) — tab counts derived from a 25-row page are hidden as unrepresentative. */
  pageSize: number;
  /** Google Maps key for the Edit-details address search; "" hides the field. */
  mapsApiKey: string;
  /** Delivery-sync tasks stuck/failed for this shop (ADR-22) — drives the ops banner; degrades to zero on DB trouble. */
  syncIssues: DeliverySyncIssueSummary;
  /** Customer reschedules from the last 48 h not yet marked Seen — the "Rescheduled today" banner; degrades to empty. */
  recentReschedules: RecentRescheduleItem[];
  /** True when the page was server-scoped by a delivery-date tag (dated tab or date filter) — other tabs' counts are then unknowable. */
  dateScoped: boolean;
};

export const loader = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const rawDeliveryDateParam = url.searchParams.get("deliveryDate");
  const deliveryDateParam = isIsoDateParam(rawDeliveryDateParam)
    ? rawDeliveryDateParam
    : null;

  const searchParam = url.searchParams.get("search")?.trim() ?? "";
  const timeWindowParam = url.searchParams.get("timeWindow")?.trim() ?? "";
  const tabParam = url.searchParams.get("tab") ?? "all";
  const rawSortParam = url.searchParams.get("sort")?.trim() ?? "";
  const sortParam = SORT_PARAM_VALUES.has(rawSortParam)
    ? rawSortParam
    : DEFAULT_SORT;

  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  // "Today" is the SHOP's calendar day (event tags, cutoffs, and the booked
  // counts all already run on rules.timezone — the client must agree). The
  // timezone read is non-critical: a Postgres hiccup falls back to the shop
  // default instead of failing the page. Resolved BEFORE the query is built
  // because the dated views now send the day's tag as a server term.
  let shopTimezone = DEFAULT_DELIVERY_SCHEDULE_RULES.timezone;
  try {
    ({ timezone: shopTimezone } = await getScheduleRules(session.shop));
  } catch (error) {
    console.warn(
      `[orders loader] timezone read failed, using ${shopTimezone}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const todayISO = getShopLocalDate(shopTimezone) || toLocalISODate(new Date());

  // Build composite Shopify query string from the SERVER-supported filters.
  //
  // ⚠️ Metafield terms (`metafields.custom.date` / `metafields.custom.time_slot`)
  // are deliberately NOT sent: Shopify silently ignores metafield search terms
  // on the orders query unless the definition is indexed as filterable
  // (verified live 2026-07-11 — an applied time-slot filter returned every
  // order unfiltered). The delivery-date TAG, however, IS exact-match
  // searchable, and since 2026-09-04 the dated views send it (below); the
  // time-slot filter stays CLIENT-side (slot tags carry legacy spelling
  // variants) over the enlarged page, as before.
  const queryParts: string[] = [];

  if (searchParam) {
    // A raw ":" parses as a field:value operator in Shopify's search syntax
    // (e.g. "status:closed" typed into the search box widens the All view
    // past its -status:closed guard) — quote such input so it searches as a
    // literal term. Plain searches pass through untouched.
    queryParts.push(
      searchParam.includes(":")
        ? `"${searchParam.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : searchParam,
    );
  }
  if (tabParam === "unfulfilled") {
    // status:open — the workqueue: excludes archived AND cancelled orders.
    queryParts.push("fulfillment_status:unfulfilled status:open");
  } else if (tabParam === "unpaid") {
    queryParts.push(
      "(financial_status:pending OR financial_status:authorized OR financial_status:partially_paid) status:open",
    );
  } else if (tabParam === "archived") {
    queryParts.push("status:closed");
  } else {
    // Archived orders are hidden from every main view (the Archive modal
    // promises this) but stay reachable via the Archived tab. Deliberately
    // -status:closed and NOT status:open: status:open would also hide
    // cancelled orders, which must remain visible with a Cancelled badge
    // (both verified live on flowercart-dev, 2026-07-12).
    queryParts.push("-status:closed");
  }

  // Dated views (2026-09-04): every synced order carries its delivery date
  // as a bare `YYYY-MM-DD` tag (written by the orders/create sync, re-synced
  // by both reschedule paths), and tag search is exact-match. Sending it
  // means a dated tab lists EVERY order for that day; the old 250-newest
  // window silently dropped old pre-orders and far-forward reschedules
  // (#4030, placed Aug 7 for Sep 5, was invisible on Tomorrow). The client's
  // metafield filter below still runs as the safety net.
  const dateRefs = computeDateRefs(todayISO);
  const tabDates =
    tabParam === "today"
      ? [dateRefs.todayISO]
      : tabParam === "yesterday"
        ? [dateRefs.yesterdayISO]
        : tabParam === "tomorrow"
          ? [dateRefs.tomorrowISO]
          : tabParam === "thisWeek"
            ? enumerateISODates(dateRefs.startWeekISO, dateRefs.endWeekISO)
            : tabParam === "lastWeek"
              ? enumerateISODates(dateRefs.lastWeekStartISO, dateRefs.lastWeekEndISO)
              : [];
  const tabDateTerm = buildDeliveryDateTagQuery(tabDates);
  if (tabDateTerm) queryParts.push(tabDateTerm);
  const filterDateTerm = deliveryDateParam
    ? buildDeliveryDateTagQuery([deliveryDateParam])
    : "";
  if (filterDateTerm) queryParts.push(filterDateTerm);
  // Echoed to the client: a date-scoped page can only count its own view.
  const dateScoped = Boolean(tabDateTerm || filterDateTerm);

  const compositeQuery = queryParts.join(" ") || null;

  // Client-side slot filtering (and the metafield safety net) needs rows to
  // filter from. Dated views are server-scoped to the day's orders now, so
  // 250 is a generous ceiling rather than the whole workable window.
  const needsClientFilter =
    tabParam === "today" ||
    tabParam === "yesterday" ||
    tabParam === "tomorrow" ||
    tabParam === "thisWeek" ||
    tabParam === "lastWeek" ||
    Boolean(deliveryDateParam) ||
    Boolean(timeWindowParam);
  const pageSize = needsClientFilter ? 250 : 25;

  const variables = {
    first: before ? null : pageSize,
    after,
    last: before ? pageSize : null,
    before,
    query: compositeQuery,
    reverse: sortParam !== "orderDate asc",
  };

  // The banner's query rides alongside the page query; it fails open on its
  // own, so it can never take the table down with it.
  const [response, recentRescheduleOrders] = await Promise.all([
    admin.graphql(GET_ORDERS_QUERY, { variables }),
    fetchRecentRescheduleOrders(admin, todayISO),
  ]);
  const body = (await response.json()) as {
    data?: {
      orders?: {
        edges?: Array<{ node: Order }>;
        pageInfo?: PageInfo | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const orders =
    body.data?.orders?.edges?.map((edge: { node: Order }) => edge.node) ?? [];

  // Email-sent history (E-5 revisit, docs/customer-email-design.md) lives in
  // Postgres, never on the Shopify order — one lookup keyed by this page's
  // order ids, grouped and attached below. Panel-timeline garnish, not
  // page-critical: a Neon cold-start rejection here must degrade to an empty
  // list, never 500 the whole ops page — and on the Today view this loader
  // re-runs every 5 minutes, so the exposure is constant.
  const orderIds = orders.map((o) => o.id);
  let emailLogRows: Array<{
    shopifyOrderId: string;
    sentAt: Date;
    to: string;
  }> = [];
  if (orderIds.length > 0) {
    try {
      emailLogRows = await prisma.emailSendLog.findMany({
        where: { shop: session.shop, shopifyOrderId: { in: orderIds } },
        orderBy: { sentAt: "desc" },
      });
    } catch (error) {
      console.warn(
        `[orders loader] email enrichment skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const emailLogByOrderId = new Map<string, { sentAt: string; to: string }[]>();
  for (const row of emailLogRows) {
    const list = emailLogByOrderId.get(row.shopifyOrderId) ?? [];
    list.push({ sentAt: row.sentAt.toISOString(), to: row.to });
    emailLogByOrderId.set(row.shopifyOrderId, list);
  }
  for (const order of orders) {
    order.emailLog = emailLogByOrderId.get(order.id) ?? [];
  }

  // Shop-local reschedule labels are stamped here, not in the browser: the
  // client has todayISO but not the shop timezone, and a VA on a non-Manila
  // machine must read the same "8:47 AM" as the merchant.
  const shopLocal = { todayISO, timezone: shopTimezone };
  for (const order of orders) {
    order.rescheduleBadgeLabel = rescheduleBadgeLabel(order, shopLocal);
  }
  const recentReschedules = selectRecentReschedules(
    recentRescheduleOrders,
    shopLocal,
  );

  // Sync-issue banner count (ADR-22): same guarded posture as the enrichment
  // above — banner garnish, never page-critical.
  let syncIssues: DeliverySyncIssueSummary = { count: 0, orderNames: [] };
  try {
    syncIssues = await getDeliverySyncIssues(session.shop);
  } catch (error) {
    console.warn(
      `[orders loader] sync-issue count skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return Response.json(
    {
      orders,
      pageInfo: body.data?.orders?.pageInfo ?? null,
      errors: body.errors ?? null,
      deliveryDateParam,
      searchParam,
      timeWindowParam,
      tabParam,
      sortParam,
      todayISO,
      pageSize,
      syncIssues,
      recentReschedules,
      dateScoped,
      // Client-exposed by design (Maps JS SDK requires it in the browser) —
      // the key itself must be locked down in the Google Cloud console:
      // HTTP-referrer restriction + Places API only.
      mapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
    } satisfies LoaderData,
    { headers: { "Cache-Control": "no-store" } },
  );
};

// ─── Bulk action types (moved to services/bulk-actions.server.ts, ADR-22 Phase B) ──
//
// The executor, its mutations, and the result types now live in the shared
// service so the inline path and the Cloud Tasks worker cannot drift.
// Re-exported here so existing imports (useBulkActions) keep their path.
export type { BulkActionName, BulkActionResponse } from "../services/bulk-actions.server";

// Shopify's real per-tag cap is 40, not 255 (live-verified 2026-08-14) —
// single-sourced in lib/order-tags.ts.
const MAX_TAG_LENGTH = MAX_ORDER_TAG_LENGTH;


// ─── Action handler ───────────────────────────────────────────────────────────

export const action = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      {
        ok: false,
        action: null,
        message: "Method not allowed.",
        results: [],
        summary: { ok: 0, failed: 0 },
      } satisfies BulkActionResponse,
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  const fd = await request.formData();
  const opRaw = String(fd.get("_action") || "");

  // Customer Email (customer-email-design.md): single-order in-app compose,
  // dispatched before the bulk machinery. Writes nothing to the Shopify order
  // (E-5), so /app/orders stays a 4-write-path route — it logs the send to
  // Postgres (EmailSendLog) purely for the panel timeline, not a delivery write.
  if (opRaw === "sendEmail") {
    return handleSendEmailOp(admin, fd, session.shop);
  }

  // Seen on the "Rescheduled today" banner: records the acknowledged event's
  // requestedAt on `$app.reschedule_seen_at`. An order write, NOT a delivery
  // write (none of the api.md §2 fields) — single orderId, so it dispatches
  // before the bulk machinery like the ops around it.
  if (opRaw === "markRescheduleSeen") {
    return handleMarkRescheduleSeenOp(admin, fd);
  }

  // Edit details: single-order shipping-address rewrite from the panel's
  // Actions menu. An order write, but NOT a delivery write — it touches no
  // delivery metafield, tag, or customAttribute, so the §2 contract in
  // docs/api.md is unchanged. Dispatched before the bulk machinery for the
  // same reason sendEmail is: it carries one orderId, not a selection.
  if (opRaw === "editDetails") {
    // The scheduler config timezone is the app's notion of "the merchant's
    // day" and already governs every delivery date, so the event tag is
    // stamped from the same source the reschedule op uses — otherwise two ops
    // minutes apart could tag different days.
    const { timezone } = await getScheduleRules(session.shop);
    return handleEditDetailsOp(admin, fd, timezone);
  }

  // Retry stuck delivery syncs (ADR-22): re-arms failed/stuck DeliverySyncTask
  // rows and enqueues a worker task each. Carries no orderId selection, so it
  // dispatches before the bulk machinery like sendEmail/editDetails.
  if (opRaw === "retryDeliverySync") {
    try {
      const { retried } = await retryDeliverySyncIssues(session.shop);
      return Response.json({
        ok: true,
        action: "retryDeliverySync",
        message:
          retried > 0
            ? `Retrying delivery sync for ${retried} order${retried === 1 ? "" : "s"} in the background.`
            : "Nothing left to retry.",
        retried,
      });
    } catch (error) {
      console.warn(
        `[orders action] retryDeliverySync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // ADR-11: upstream trouble is 200 + ok:false, never a 5xx.
      return Response.json({
        ok: false,
        action: "retryDeliverySync",
        message: "Could not restart the delivery sync. Try again in a moment.",
        retried: 0,
      });
    }
  }

  const op = isBulkActionName(opRaw) ? opRaw : "";
  const orderIds = Array.from(
    new Set(
      fd
        .getAll("orderId")
        .map((v) => String(v))
        .filter(Boolean),
    ),
  );

  const empty: BulkActionResponse = {
    ok: false,
    action: (op || null) as BulkActionName | null,
    message: "No orders selected.",
    results: [],
    summary: { ok: 0, failed: 0 },
  };

  if (!op) {
    return Response.json(
      { ...empty, message: opRaw ? "Unknown action." : "Missing action." },
      { status: 400 },
    );
  }
  if (orderIds.length === 0) {
    return Response.json(empty, { status: 400 });
  }
  if (orderIds.length > MAX_SELECTED_ORDER_IDS) {
    return Response.json(
      {
        ...empty,
        message: `Select ${MAX_SELECTED_ORDER_IDS} or fewer orders at a time.`,
      },
      { status: 400 },
    );
  }

  // ── Parse + validate op params (ADR-22 Phase B): validation happens BEFORE
  //    the inline/job split, so a BulkOpParams is valid by construction
  //    wherever it ends up — executed inline below, or snapshotted into a
  //    BulkActionJob for the Cloud Tasks worker. The execution itself lives in
  //    executeBulkAction (services/bulk-actions.server.ts), shared by both
  //    paths so they cannot drift. ──────────────────────────────────────────
  let opParams: BulkOpParams;
  if (op === "archive" || op === "unarchive") {
    opParams = { op };
  } else if (op === "cancel") {
    const validReasons = new Set([
      "CUSTOMER",
      "INVENTORY",
      "DECLINED",
      "FRAUD",
      "STAFF",
      "OTHER",
    ]);
    const reasonRaw = String(fd.get("reason") || "CUSTOMER").toUpperCase();
    const reason = validReasons.has(reasonRaw) ? reasonRaw : "CUSTOMER";
    const restock = fd.get("restock") === "1";
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    const staffNoteRaw = String(fd.get("staffNote") || "").slice(0, 255);
    opParams = {
      op: "cancel",
      reason,
      restock,
      notifyCustomer,
      staffNote: staffNoteRaw.trim() || null,
    };
  } else if (op === "tagsAdd" || op === "tagsRemove") {
    const tags = String(fd.get("tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) {
      return Response.json(
        { ...empty, message: "Enter at least one tag." },
        { status: 400 },
      );
    }
    if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      return Response.json(
        {
          ...empty,
          message: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }
    opParams = { op, tags };
  } else if (op === "markFulfilled") {
    const trackingUrl = String(fd.get("trackingUrl") || "").trim();
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    // ADR-16: only meaningful for a single order — the modal only submits
    // this when exactly one order is selected, but re-check server-side
    // rather than trust the client.
    const lalamoveOrderId =
      orderIds.length === 1 ? String(fd.get("lalamoveOrderId") || "").trim() : "";
    if (trackingUrl && !isHttpTrackingUrl(trackingUrl)) {
      return Response.json(
        {
          ...empty,
          message: "Tracking URL must start with http:// or https://.",
        },
        { status: 400 },
      );
    }
    opParams = { op: "markFulfilled", trackingUrl, notifyCustomer, lalamoveOrderId };
  } else {
    // Merchant reschedule = administrative override (§5, ADR-10). Only the
    // data-integrity checks bind this path; the customer self-service gates
    // (resched lock, ≥2-days, FULFILLED, cutoff/prep window) deliberately do
    // not. Capacity is warn + explicit confirm override (REC-4).
    const date = String(fd.get("date") || "").trim();
    const timeSlot = String(fd.get("timeSlot") || "").trim();
    const override = fd.get("capacityOverride") === "1";

    const rules = await getScheduleRulesWithBookedCounts(session.shop, admin);
    const check = validateMerchantRescheduleSelection(rules, date, timeSlot);
    if (!check.ok) {
      return Response.json(
        { ...empty, message: check.message },
        { status: 400 },
      );
    }

    if (check.capacity) {
      // Capacity projection needs current order state; the EXECUTOR re-reads
      // state at write time (fresh per chunk on the worker path), so this
      // read is projection-only. Orders already sitting in the target
      // date+slot are not double-counted (§5 bulk rule) — the slot half of
      // that "already there" test uses the SAME canonical comparison the
      // booked-count matcher does (§4.2).
      const stateFetch = await fetchRescheduleOrderStates(admin, orderIds);
      if (!stateFetch.ok) {
        return Response.json({
          ...empty,
          message: stateFetch.message,
          results: orderIds.map((id) => ({
            orderId: id,
            success: false,
            message: stateFetch.message,
          })),
          summary: { ok: 0, failed: orderIds.length },
        } satisfies BulkActionResponse);
      }
      const moving = orderIds.filter((id) => {
        const state = stateFetch.stateByOrderId.get(id);
        if (!state) return false;
        return (
          rescheduleCurrentDateOf(state) !== date ||
          !slotValuesMatch(rescheduleCurrentSlotOf(state), timeSlot)
        );
      }).length;
      const projected = check.capacity.booked + moving;
      if (moving > 0 && projected > check.capacity.capacity && !override) {
        return Response.json(
          {
            ...empty,
            message: `Moving ${moving} ${moving === 1 ? "order" : "orders"} would put ${date} ${timeSlot} at ${projected}/${check.capacity.capacity}.`,
            code: "capacity_override_required",
            capacity: {
              capacity: check.capacity.capacity,
              booked: check.capacity.booked,
              moving,
              projected,
            },
          } satisfies BulkActionResponse,
          { status: 409 },
        );
      }
    }

    opParams = {
      op: "reschedule",
      date,
      timeSlot,
      // Customer notice (2026-09-04): the modal's checkbox, default on. The
      // executor sends it AFTER a successful write and never lets a send
      // failure fail the reschedule.
      notifyCustomer: fd.get("notifyCustomer") === "1",
      // Stamped once here so every chunk/retry writes the same history
      // timestamp.
      requestedAt: new Date().toISOString(),
      shopTimezone: rules.timezone,
    };
  }

  // ── Inline vs job (ADR-22 Phase B; threshold = merchant decision
  //    2026-08-26): small selections stay synchronous exactly as before,
  //    large ones become a job the client polls — the response never again
  //    outlives the embedded fetcher / Cloudflare window (S4). ─────────────
  if (orderIds.length > BULK_INLINE_MAX) {
    const { jobId } = await createBulkActionJob(session.shop, opParams, orderIds);
    const enqueued = await enqueueBulkActionTask({ jobId });
    if (!enqueued.ok) {
      if (!enqueued.notConfigured) {
        console.warn(
          `[orders action] bulk-job enqueue failed (${enqueued.error}); running in-process.`,
        );
      }
      // Local dev (no queue) or an enqueue hiccup: run in-process WITHOUT
      // awaiting — the response must stay fast (the whole point of Phase B);
      // the hourly sweep rescues the job if this process dies mid-run.
      void runBulkJobToCompletion(jobId);
    }
    return Response.json({
      ok: true,
      action: op,
      mode: "job",
      jobId,
      total: orderIds.length,
      message: `Processing ${orderIds.length} orders in the background.`,
      results: [],
      summary: { ok: 0, failed: 0 },
    } satisfies BulkActionResponse);
  }

  const results: BulkActionItemResult[] = await executeBulkAction(
    admin,
    session.shop,
    opParams,
    orderIds,
  );

  const okCount = results.filter((r) => r.success).length;
  const failedCount = results.length - okCount;
  const payload: BulkActionResponse = {
    ok: failedCount === 0,
    action: op,
    results,
    summary: { ok: okCount, failed: failedCount },
  };
  return Response.json(payload);
};

// ─── Tab types ────────────────────────────────────────────────────────────────

type ActiveTab =
  | "all"
  | "today"
  | "yesterday"
  | "tomorrow"
  | "thisWeek"
  | "lastWeek"
  | "unfulfilled"
  | "unpaid"
  | "archived";

// ─── Main Extension ───────────────────────────────────────────────────────────

function Extension() {
  const loaderData = useLoaderData() as LoaderData;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const orders = loaderData.orders;
  const pageInfo = loaderData.pageInfo;
  const loading = navigation.state === "loading";
  const deliveryDateFilter = loaderData.deliveryDateParam || "";

  // URL-driven filter params (from loader — always in sync with what the server fetched)
  const searchParam = loaderData.searchParam;
  const timeWindowParam = loaderData.timeWindowParam;
  const tabParam = loaderData.tabParam as ActiveTab;
  const sortParam = loaderData.sortParam;

  const [error] = useState<string | null>(
    loaderData.errors
      ? loaderData.errors.map((e) => e.message).join(", ")
      : null,
  );
  const [errorDismissed, setErrorDismissed] = useState<boolean>(false);

  // Local draft for the search input — debounced to URL via useEffect
  const [searchTerm, setSearchTerm] = useState<string>(searchParam);
  const searchParamRef = useRef(searchParam);

  // Date references for tab filtering, derived from the SHOP-local todayISO
  // the loader stamped — never from the browser clock, which drifts from the
  // shop day on a non-Manila machine. Keyed on todayISO so every loader
  // settle (including the §6 auto-refresh) rolls the boundary over at the
  // shop's midnight; the old once-per-mount version kept filtering "Today"
  // on yesterday during a past-midnight prep session. All arithmetic is UTC
  // over the ISO string, so no timezone conversion can shift the day.
  // Same helper the loader uses for its server-side date-tag terms
  // (lib/date-refs.ts) — one definition of tomorrow / this week on both ends.
  const dateRefs = useMemo(
    () => computeDateRefs(loaderData.todayISO),
    [loaderData.todayISO],
  );

  // ── Client-side view shaping — every delivery-date/time-slot constraint is
  //    applied HERE, not in the loader query: Shopify ignores metafield search
  //    terms on orders unless the definition is indexed as filterable
  //    (verified live 2026-07-11), so the loader fetches an enlarged page and
  //    the date tabs + both toolbar filters narrow it locally (the original
  //    thisWeek pattern, extended). The deliveryDate sort options also apply
  //    here because the Admin API has no metafield sort key. ─────────────────

  const displayedOrders: Order[] = useMemo(() => {
    let list = orders;
    if (tabParam === "today") {
      list = list.filter(
        (order) => getDeliveryDateValue(order) === dateRefs.todayISO,
      );
    } else if (tabParam === "yesterday") {
      list = list.filter(
        (order) => getDeliveryDateValue(order) === dateRefs.yesterdayISO,
      );
    } else if (tabParam === "tomorrow") {
      list = list.filter(
        (order) => getDeliveryDateValue(order) === dateRefs.tomorrowISO,
      );
    } else if (tabParam === "thisWeek") {
      list = list.filter((order) => {
        const d = getDeliveryDateValue(order);
        return (
          d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
        );
      });
    } else if (tabParam === "lastWeek") {
      list = list.filter((order) => {
        const d = getDeliveryDateValue(order);
        return (
          d !== "—" &&
          d >= dateRefs.lastWeekStartISO &&
          d <= dateRefs.lastWeekEndISO
        );
      });
    }
    if (deliveryDateFilter) {
      list = list.filter(
        (order) => getDeliveryDateValue(order) === deliveryDateFilter,
      );
    }
    if (timeWindowParam) {
      list = list.filter(
        (order) => getDeliveryTimeValue(order) === timeWindowParam,
      );
    }
    if (sortParam === "deliveryDate asc" || sortParam === "deliveryDate desc") {
      const dir = sortParam.endsWith("asc") ? 1 : -1;
      list = [...list].sort((a, b) => {
        const da = getDeliveryDateValue(a);
        const db = getDeliveryDateValue(b);
        if (da === "—" && db === "—") return 0;
        if (da === "—") return 1; // undated orders always sink to the bottom
        if (db === "—") return -1;
        return da < db ? -dir : da > db ? dir : 0;
      });
    }
    return list;
  }, [orders, tabParam, dateRefs, sortParam, deliveryDateFilter, timeWindowParam]);

  // ── Row selection — Polaris useIndexResourceState replaces the manual
  //    selectedIds Set (+ useFilteredSelection) ───────────────────────────────

  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
    removeSelectedResources,
  } = useIndexResourceState(
    displayedOrders as unknown as { [key: string]: unknown }[],
    { resourceIDResolver: (resource) => String(resource.id) },
  );

  // Prune selected ids that are no longer in the displayed set (filter/tab/
  // pagination/revalidation changes) — same behavior as the old
  // useFilteredSelection.
  useEffect(() => {
    const visible = new Set(displayedOrders.map((o) => o.id));
    const gone = selectedResources.filter((id) => !visible.has(id));
    if (gone.length > 0) removeSelectedResources(gone);
  }, [displayedOrders, selectedResources, removeSelectedResources]);

  // Clear selection when tab changes (tabParam is URL-driven). clearSelection
  // comes from useIndexResourceState with no stable-identity guarantee, so it
  // is read through a ref to keep this effect keyed on tabParam only.
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;
  useEffect(() => {
    clearSelectionRef.current();
  }, [tabParam]);

  // ── Bulk actions (archive / unarchive / cancel / tags / fulfill) ───────────
  //    Submission, toast handling, and modal visibility live in useBulkActions.

  const {
    isSubmitting,
    activeModal,
    openModal,
    closeModal,
    lastActionResult,
    submitReschedule,
    cancelReason,
    setCancelReason,
    cancelRestock,
    setCancelRestock,
    cancelNotify,
    setCancelNotify,
    cancelStaffNote,
    setCancelStaffNote,
    addTagsInput,
    setAddTagsInput,
    removeTagsInput,
    setRemoveTagsInput,
    fulfillTrackingUrl,
    setFulfillTrackingUrl,
    fulfillNotify,
    setFulfillNotify,
    fulfillLalamoveOrderId,
    setFulfillLalamoveOrderId,
    handleArchiveConfirm,
    handleUnarchiveConfirm,
    handleCancelConfirm,
    handleAddTags,
    handleRemoveTags,
    handleMarkFulfilled,
    activeJob,
    jobProgress,
  } = useBulkActions(selectedResources, clearSelection, removeSelectedResources);

  // Shared row-level tags modal + KPI items-to-prepare modal — plain React
  // open state (the old counter/ref + command-API patterns are gone).
  const [tagsModalOrderId, setTagsModalOrderId] = useState<string | null>(null);
  const [kpiProductsOpen, setKpiProductsOpen] = useState(false);

  // ── Smart auto-refresh (§6, Phase 3) — 30-min default / 5-min Today cadence
  //    via useRevalidator (URL state preserved; the background refresh shows
  //    no loading bar — only the manual Refresh button spins). Paused while
  //    any modal is open or any action fetcher is in flight (useFetchers sees
  //    every fetcher on the page, including the panel's tag form). A
  //    read-only open panel does NOT pause refresh; dirty-form tracking
  //    arrives with the Phase 4 reschedule form. ────────────────────────────
  const fetchers = useFetchers();
  const actionInFlight = fetchers.some((f) => f.state !== "idle");
  // Any modal stacked over the page — pauses the smart refresh below, and
  // disables the details panel's own Escape handler (one Esc otherwise
  // closed the modal AND the panel underneath it, taking a half-typed
  // compose down with the ?order= param).
  const anyModalOpen =
    activeModal !== null || tagsModalOrderId !== null || kpiProductsOpen;
  const refreshPaused = anyModalOpen || actionInFlight;
  const { lastUpdatedLabel, refresh, isRefreshing } = useSmartRefresh({
    isTodayView: tabParam === "today",
    paused: refreshPaused,
    dataStamp: loaderData,
  });

  // View identity for the background diff — every URL param except ?order
  // (the panel toggle doesn't re-run the loader, see shouldRevalidate). Same
  // key = same view, so a data change is a background update worth flagging.
  const ordersViewKey = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    params.delete("order");
    params.sort();
    return params.toString();
  }, [searchParams]);
  const {
    newIds: newOrderIds,
    changedIds: changedOrderIds,
    dismiss: dismissOrdersDiff,
  } = useOrdersDiff(displayedOrders, ordersViewKey);

  // ADR-22 sync-issue banner: dedicated fetcher — it counts into
  // actionInFlight via useFetchers above, so the smart refresh pauses while a
  // retry runs, and its completion revalidates the loader (banner updates).
  const syncRetryFetcher = useFetcher<{ ok: boolean; message: string }>();

  // "Rescheduled today" banner: Seen goes through its own fetcher (it counts
  // into actionInFlight like the retry above). The acknowledged row hides
  // optimistically while the submit + revalidation run, then the loader stops
  // returning it — no client-side list surgery.
  const rescheduleSeenFetcher = useFetcher<{ ok: boolean; message: string }>();
  const pendingSeenIds = useMemo(() => {
    const ids = new Set<string>();
    if (rescheduleSeenFetcher.state !== "idle") {
      for (const id of rescheduleSeenFetcher.formData?.getAll("orderId") ?? []) {
        if (typeof id === "string") ids.add(id);
      }
    }
    return ids;
  }, [rescheduleSeenFetcher.state, rescheduleSeenFetcher.formData]);
  // One op for both buttons: parallel orderId/requestedAt pairs (the service
  // chunks the metafield writes), so "Mark all" after a 30-order bulk
  // reschedule is one round trip, not thirty.
  const submitReschedulesSeen = useCallback(
    (items: RecentRescheduleItem[]) => {
      if (items.length === 0) return;
      const fd = new FormData();
      fd.append("_action", "markRescheduleSeen");
      for (const item of items) {
        fd.append("orderId", item.orderId);
        fd.append("requestedAt", item.requestedAt);
      }
      rescheduleSeenFetcher.submit(fd, { method: "post" });
    },
    [rescheduleSeenFetcher],
  );
  const markRescheduleSeen = useCallback(
    (item: RecentRescheduleItem) => submitReschedulesSeen([item]),
    [submitReschedulesSeen],
  );

  const ordersDiffTitle = useMemo(() => {
    const parts: string[] = [];
    if (newOrderIds.size > 0) {
      parts.push(
        `${newOrderIds.size} new ${newOrderIds.size === 1 ? "order" : "orders"}`,
      );
    }
    if (changedOrderIds.size > 0) {
      parts.push(
        `${changedOrderIds.size} schedule ${changedOrderIds.size === 1 ? "update" : "updates"}`,
      );
    }
    return parts.join(" · ");
  }, [newOrderIds, changedOrderIds]);

  // Right-side panel state — URL-driven via ?order=<numeric id> (REC-7) so the
  // open panel deep-links, survives refresh, and persists across revalidation.
  // The panel still derives its order from fresh loader data by ID.
  // Sidekick's app-action deep link may hand us a full GID
  // (gid://shopify/Order/123) instead of the numeric legacy id the panel keys
  // off. Normalise to the trailing segment — a plain numeric param is
  // unchanged by this.
  const rawSelectedOrderParam = searchParams.get("order");
  const selectedOrderParam = rawSelectedOrderParam
    ? rawSelectedOrderParam.split("/").pop() || rawSelectedOrderParam
    : null;
  const matchedPanelOrder = selectedOrderParam
    ? (orders.find(
        (o) => (o.id.split("/").pop() || o.id) === selectedOrderParam,
      ) ?? null)
    : null;

  // §6: if a background revalidate drops the open order out of the loaded
  // set (the page shifted underneath it), keep the panel open on the
  // last-known snapshot with a "no longer in this view" note instead of
  // yanking it shut. The ref is a render-time cache of the last match; it is
  // only reused while ?order= still names the same order.
  const lastPanelOrderRef = useRef<Order | null>(null);
  if (matchedPanelOrder) {
    lastPanelOrderRef.current = matchedPanelOrder;
  } else if (!selectedOrderParam) {
    lastPanelOrderRef.current = null;
  }
  const panelSnapshot =
    !matchedPanelOrder &&
    selectedOrderParam &&
    lastPanelOrderRef.current &&
    (lastPanelOrderRef.current.id.split("/").pop() ||
      lastPanelOrderRef.current.id) === selectedOrderParam
      ? lastPanelOrderRef.current
      : null;
  const selectedOrder = matchedPanelOrder ?? panelSnapshot;
  const selectedOrderNotInView = panelSnapshot !== null;

  // ── Merchant reschedule (Phase 4) — one modal for the bulk-actions bar
  //    (selection) and the panel's single-order "Update delivery slot".
  //    Delivery rules (slots/blocked/capacity+booked) load lazily when the
  //    modal first opens; React Router re-runs the fetcher loader after every
  //    action, so booked counts stay fresh across consecutive reschedules. ──
  const [panelRescheduleIds, setPanelRescheduleIds] = useState<
    string[] | null
  >(null);
  useEffect(() => {
    if (activeModal !== "reschedule" && panelRescheduleIds !== null) {
      setPanelRescheduleIds(null);
    }
  }, [activeModal, panelRescheduleIds]);

  const rescheduleRulesFetcher = useFetcher<RescheduleRulesData>();
  useEffect(() => {
    if (activeModal !== "reschedule") return;
    if (rescheduleRulesFetcher.state !== "idle" || rescheduleRulesFetcher.data)
      return;
    rescheduleRulesFetcher.load("/app/orders/reschedule-rules");
  }, [activeModal, rescheduleRulesFetcher]);

  const openPanelReschedule = useCallback(() => {
    if (!selectedOrder) return;
    setPanelRescheduleIds([selectedOrder.id]);
    openModal("reschedule");
  }, [selectedOrder, openModal]);

  // Customer Email — panel-only compose; the modal reads its target from the
  // open panel order (?order=), never from the bulk selection.
  const openPanelSendEmail = useCallback(() => {
    if (!selectedOrder) return;
    openModal("sendEmail");
  }, [selectedOrder, openModal]);

  // Edit details — panel-only, same shape as the compose modal above: the
  // target comes from the open panel order (?order=), never the selection.
  const openPanelEditDetails = useCallback(() => {
    if (!selectedOrder) return;
    openModal("editDetails");
  }, [selectedOrder, openModal]);

  const rescheduleTargets = useMemo<RescheduleTarget[]>(() => {
    if (activeModal !== "reschedule") return [];
    const ids = panelRescheduleIds ?? selectedResources;
    const found: RescheduleTarget[] = [];
    for (const id of ids) {
      const order =
        orders.find((o) => o.id === id) ??
        (selectedOrder && selectedOrder.id === id ? selectedOrder : null);
      if (!order) continue;
      const currentDate = getDeliveryDateValue(order);
      const currentSlot = getDeliveryTimeValue(order);
      found.push({
        id,
        name: order.name,
        currentDate: currentDate === "—" ? null : currentDate,
        currentSlot: currentSlot === "—" ? null : currentSlot,
      });
    }
    return found;
  }, [activeModal, panelRescheduleIds, selectedResources, orders, selectedOrder]);

  const rescheduleServerCapacity =
    lastActionResult?.action === "reschedule" &&
    lastActionResult.code === "capacity_override_required" &&
    lastActionResult.capacity
      ? lastActionResult.capacity
      : null;

  // PUSH (not replace) navigations here: pushed history entries mirror to the
  // outer admin URL, and Back closes the panel (verified live 2026-07-11).
  // Opening the panel also closes any open modal (§4 of the V2 design).
  const openOrderPanel = useCallback(
    (orderId: string) => {
      closeModal();
      setTagsModalOrderId(null);
      setKpiProductsOpen(false);
      const params = new URLSearchParams(searchParams);
      const numericId = orderId.split("/").pop() || orderId;
      if (params.get("order") === numericId) return;
      params.set("order", numericId);
      navigate(`?${params.toString()}`, { preventScrollReset: true });
    },
    [searchParams, navigate, closeModal],
  );

  // Banner "Open": the moved order is usually OUTSIDE the current view (it
  // just left Today), and the panel only renders orders present on the loaded
  // page — so jump to All + search by order number (guarantees it is on the
  // page), then open it.
  const openRecentReschedule = useCallback(
    (item: RecentRescheduleItem) => {
      closeModal();
      setTagsModalOrderId(null);
      setKpiProductsOpen(false);
      const params = new URLSearchParams(searchParams);
      params.delete("tab");
      params.delete("timeWindow");
      params.delete("deliveryDate");
      params.delete("after");
      params.delete("before");
      params.set("search", item.name.replace(/^#/, ""));
      params.set("order", item.legacyId);
      clearSelection();
      navigate(`?${params.toString()}`);
    },
    [searchParams, navigate, closeModal, clearSelection],
  );

  const handleCloseDrawer = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    if (!params.has("order")) return;
    params.delete("order");
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  }, [searchParams, navigate]);

  // Sync local search draft when loader returns a new searchParam (e.g., back navigation)
  useEffect(() => {
    searchParamRef.current = searchParam;
    setSearchTerm(searchParam);
  }, [searchParam]);

  // Debounce search draft → URL param (fires only when draft differs from last committed value)
  useEffect(() => {
    if (searchTerm === searchParamRef.current) return;
    const timer = setTimeout(() => {
      searchParamRef.current = searchTerm;
      const params = new URLSearchParams(searchParams);
      if (searchTerm.trim()) {
        params.set("search", searchTerm.trim());
      } else {
        params.delete("search");
      }
      params.delete("after");
      params.delete("before");
      navigate(`?${params.toString()}`, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm, searchParams, navigate]);

  // Clearing search (the ✕ button) commits IMMEDIATELY instead of waiting for
  // the 300ms debounce — the deferred commit was observed to occasionally get
  // lost between navigations (2026-07-11 smoke test round 2).
  const handleQueryClear = useCallback((): void => {
    setSearchTerm("");
    searchParamRef.current = "";
    const params = new URLSearchParams(searchParams);
    if (!params.has("search")) return;
    params.delete("search");
    params.delete("after");
    params.delete("before");
    navigate(`?${params.toString()}`, { replace: true });
  }, [searchParams, navigate]);

  // ── Tab / filter / sort handlers — all map onto URL params ─────────────────

  const handleTabChange = useCallback(
    (tab: string): void => {
      const params = new URLSearchParams(searchParams);
      if (tab === "all") {
        params.delete("tab");
      } else {
        params.set("tab", tab);
      }
      params.delete("after");
      params.delete("before");
      clearSelection();
      navigate(`?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate, clearSelection],
  );

  const handleDateChange = useCallback(
    (value: string): void => {
      const iso = normalizeDateToISO(value);
      const params = new URLSearchParams(searchParams);
      if (iso) {
        params.set("deliveryDate", iso);
      } else {
        params.delete("deliveryDate");
      }
      params.delete("after");
      params.delete("before");
      clearSelection();
      navigate(`?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate, clearSelection],
  );

  const handleTimeWindowChange = useCallback(
    (value: string): void => {
      const params = new URLSearchParams(searchParams);
      if (value) {
        params.set("timeWindow", value);
      } else {
        params.delete("timeWindow");
      }
      params.delete("after");
      params.delete("before");
      clearSelection();
      navigate(`?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate, clearSelection],
  );

  const handleSortChange = useCallback(
    (value: string): void => {
      const params = new URLSearchParams(searchParams);
      if (value === DEFAULT_SORT) {
        params.delete("sort");
      } else {
        params.set("sort", value);
      }
      params.delete("after");
      params.delete("before");
      navigate(`?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate],
  );

  const handleClearFilters = useCallback((): void => {
    const params = new URLSearchParams(searchParams);
    params.delete("search");
    params.delete("tab");
    params.delete("timeWindow");
    params.delete("deliveryDate");
    params.delete("after");
    params.delete("before");
    setSearchTerm("");
    clearSelection();
    navigate(`?${params.toString()}`, { replace: true });
  }, [searchParams, navigate, clearSelection]);

  // ── Pagination handlers — update URL cursors to trigger loader refetch ──────

  const handleNextPage = useCallback((): void => {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("after", pageInfo.endCursor);
    params.delete("before");
    navigate(`?${params.toString()}`, { replace: true });
  }, [pageInfo, searchParams, navigate]);

  const handlePreviousPage = useCallback((): void => {
    if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("before", pageInfo.startCursor);
    params.delete("after");
    navigate(`?${params.toString()}`, { replace: true });
  }, [pageInfo, searchParams, navigate]);

  // ── KPI computations (this page only — REC-8) ──────────────────────────────

  const kpiOrderCount: number = displayedOrders.length;

  const { kpiRevenue, kpiAvgRevenue } = useMemo(() => {
    if (displayedOrders.length === 0)
      return { kpiRevenue: "—", kpiAvgRevenue: "" };
    let total = 0,
      currency = "",
      count = 0;
    for (const o of displayedOrders) {
      if (o.currentTotalPriceSet?.shopMoney) {
        total += parseFloat(o.currentTotalPriceSet.shopMoney.amount) || 0;
        if (!currency) currency = o.currentTotalPriceSet.shopMoney.currencyCode;
        count++;
      }
    }
    if (!currency) return { kpiRevenue: "—", kpiAvgRevenue: "" };
    const avg =
      count > 0
        ? (total / count).toLocaleString("en-US", {
            style: "currency",
            currency,
            maximumFractionDigits: 0,
          })
        : "";
    return {
      kpiRevenue: total.toLocaleString("en-US", {
        style: "currency",
        currency,
      }),
      kpiAvgRevenue: avg ? `Avg ${avg} / order` : "",
    };
  }, [displayedOrders]);

  const { kpiUnpaidCount, kpiUnpaidTotal } = useMemo(() => {
    let total = 0,
      currency = "";
    const count = displayedOrders.filter((o) => {
      const match = isUnpaidStatus(o.displayFinancialStatus);
      if (match && o.currentTotalPriceSet?.shopMoney) {
        total += parseFloat(o.currentTotalPriceSet.shopMoney.amount) || 0;
        if (!currency) currency = o.currentTotalPriceSet.shopMoney.currencyCode;
      }
      return match;
    }).length;
    const totalStr =
      currency && total > 0
        ? total.toLocaleString("en-US", { style: "currency", currency })
        : "";
    return {
      kpiUnpaidCount: count,
      kpiUnpaidTotal: totalStr ? `${totalStr} pending` : "",
    };
  }, [displayedOrders]);

  const { kpiUnfulfilledCount, kpiUnfulfilledDueToday } = useMemo(() => {
    // Cancelled orders keep UNFULFILLED as their fulfillment status — they are
    // not pending work, so they don't belong in the unfulfilled KPI (S11).
    const count = displayedOrders.filter(
      (o) =>
        !o.cancelledAt &&
        o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
    ).length;
    const dueToday = displayedOrders.filter((o) => {
      if (o.cancelledAt) return false;
      if (o.displayFulfillmentStatus?.toUpperCase() !== "UNFULFILLED")
        return false;
      const d = getDeliveryDateValue(o);
      return d !== "—" && d <= dateRefs.todayISO;
    }).length;
    return {
      kpiUnfulfilledCount: count,
      kpiUnfulfilledDueToday: dueToday,
    };
  }, [displayedOrders, dateRefs.todayISO]);

  const { kpiProducts } = useMemo(() => {
    if (displayedOrders.length === 0)
      return { kpiProducts: [] as [string, number][] };
    const productMap = new Map<string, number>();

    for (const o of displayedOrders) {
      if (o.cancelledAt) continue; // F07: cancelled orders do not contribute to products to prepare
      const items = o.lineItems?.edges || [];
      for (const item of items) {
        const qty = item.node.quantity || 0;
        if (item.node.name) {
          const name = item.node.name;
          productMap.set(name, (productMap.get(name) || 0) + qty);
        }
      }
    }

    const sortedProducts = Array.from(productMap.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    return {
      kpiProducts: sortedProducts,
    };
  }, [displayedOrders]);

  const { kpiDeliveryFees } = useMemo(() => {
    let total = 0, currency = "";
    for (const o of displayedOrders) {
      const money = o.totalShippingPriceSet?.shopMoney;
      if (money) {
        total += parseFloat(money.amount);
        if (!currency) currency = money.currencyCode;
      }
    }
    if (!currency) return { kpiDeliveryFees: "—" };
    return {
      kpiDeliveryFees: total.toLocaleString("en-US", {
        style: "currency",
        currency,
      }),
    };
  }, [displayedOrders]);

  // ── Tab counts (for tab labels) ────────────────────────────────────────────

  const tabCounts = useMemo(() => {
    return {
      today: orders.filter((o) => getDeliveryDateValue(o) === dateRefs.todayISO)
        .length,
      yesterday: orders.filter(
        (o) => getDeliveryDateValue(o) === dateRefs.yesterdayISO,
      ).length,
      tomorrow: orders.filter(
        (o) => getDeliveryDateValue(o) === dateRefs.tomorrowISO,
      ).length,
      thisWeek: orders.filter((o) => {
        const d = getDeliveryDateValue(o);
        return (
          d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
        );
      }).length,
      lastWeek: orders.filter((o) => {
        const d = getDeliveryDateValue(o);
        return (
          d !== "—" &&
          d >= dateRefs.lastWeekStartISO &&
          d <= dateRefs.lastWeekEndISO
        );
      }).length,
      unfulfilled: orders.filter(
        (o) =>
          !o.cancelledAt &&
          o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
      ).length,
      unpaid: orders.filter((o) => isUnpaidStatus(o.displayFinancialStatus))
        .length,
    };
  }, [orders, dateRefs]);

  // Union of the selected orders' meaningful tags — clickable suggestions in
  // the Remove-tags modal (audit S4; client-side only, no server change).
  const removeTagSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const o of displayedOrders) {
      if (!selectedResources.includes(o.id)) continue;
      for (const tag of getMeaningfulTags(o.tags || [])) set.add(tag);
    }
    return Array.from(set).sort();
  }, [displayedOrders, selectedResources]);

  const sharedTagsModalTags = tagsModalOrderId
    ? getMeaningfulTags(
        orders.find((o) => o.id === tagsModalOrderId)?.tags || [],
      )
    : [];

  // ── Render ─────────────────────────────────────────────────────────────────

  // Tab counts are derived from the LOADED page only. On the server-filtered
  // tabs the page is just 25 rows, so a derived count would be badly wrong
  // ("Today (2)" while 15 exist) — counts render only when the enlarged
  // 250-row page was loaded. Even then a further server page may exist
  // (cursor pagination), so counts show as lower bounds ("12+").
  //
  // Date-scoped pages (2026-09-04): the server already narrowed the page to
  // ONE day (or one week), so the page knows its own count exactly but
  // nothing about the other tabs — only the active tab shows a count there.
  const tabCountsVisible = loaderData.pageSize >= 250;
  const tabCountsPartial = Boolean(
    pageInfo?.hasNextPage || pageInfo?.hasPreviousPage,
  );
  const tabCount = (id: string, n: number): number | null => {
    if (!tabCountsVisible) return null;
    if (loaderData.dateScoped && id !== tabParam) return null;
    return n;
  };
  const tabDefs: OrdersTabDef[] = [
    { id: "all", label: "All", count: tabCount("all", orders.length), approximate: tabCountsPartial },
    { id: "today", label: "Today", count: tabCount("today", tabCounts.today), approximate: tabCountsPartial },
    { id: "tomorrow", label: "Tomorrow", count: tabCount("tomorrow", tabCounts.tomorrow), approximate: tabCountsPartial },
    { id: "thisWeek", label: "This week", count: tabCount("thisWeek", tabCounts.thisWeek), approximate: tabCountsPartial },
    // Past views sit after the forward-looking ones so the first four tabs
    // keep their positions (Today is the merchant's daily landing tab).
    { id: "yesterday", label: "Yesterday", count: tabCount("yesterday", tabCounts.yesterday), approximate: tabCountsPartial },
    { id: "lastWeek", label: "Last week", count: tabCount("lastWeek", tabCounts.lastWeek), approximate: tabCountsPartial },
    { id: "unfulfilled", label: "Unfulfilled", count: tabCount("unfulfilled", tabCounts.unfulfilled), approximate: tabCountsPartial },
    { id: "unpaid", label: "Unpaid", count: tabCount("unpaid", tabCounts.unpaid), approximate: tabCountsPartial },
    // Archived orders are excluded from every other view's query, so no
    // client-side count is knowable here — the label renders without one.
    { id: "archived", label: "Archived", count: null },
  ];

  const hasActiveFilters = Boolean(
    searchParam ||
    timeWindowParam ||
    deliveryDateFilter ||
    tabParam !== "all",
  );

  // A search typed on a dated tab (or with a date/slot filter) still gets the
  // client-side filter applied on top, so the row the merchant is looking for
  // can be on the loaded page yet hidden by the tab — exactly what happens
  // after a customer moves an order off Today. Name those hits instead of
  // showing a bare empty state.
  const hiddenSearchMatches = useMemo(() => {
    if (!searchParam || displayedOrders.length > 0) return [];
    const clientFilterActive =
      tabParam === "today" ||
      tabParam === "yesterday" ||
      tabParam === "tomorrow" ||
      tabParam === "thisWeek" ||
      tabParam === "lastWeek" ||
      Boolean(deliveryDateFilter) ||
      Boolean(timeWindowParam);
    if (!clientFilterActive) return [];
    return orders.slice(0, 3).map((o) => {
      const date = getDeliveryDateValue(o);
      const slot = getDeliveryTimeValue(o);
      const when = [
        date !== "—" ? formatDeliveryDate(date) : "",
        slot !== "—" ? slot : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return { id: o.id, name: o.name, when: when || "no delivery date" };
    });
  }, [
    searchParam,
    displayedOrders.length,
    tabParam,
    deliveryDateFilter,
    timeWindowParam,
    orders,
  ]);
  const showSearchInAll = useCallback((): void => {
    const params = new URLSearchParams(searchParams);
    params.delete("tab");
    params.delete("timeWindow");
    params.delete("deliveryDate");
    params.delete("after");
    params.delete("before");
    clearSelection();
    navigate(`?${params.toString()}`, { replace: true });
  }, [searchParams, navigate, clearSelection]);

  const selectedCount = selectedResources.length;

  return (
    <Page title="Orders Operations" fullWidth>
      <BlockStack gap="400">
        {/* ── Error banner ──────────────────────────────────────────────────── */}
        {error && !errorDismissed && (
          <Banner
            title="Failed to load orders"
            tone="critical"
            onDismiss={() => setErrorDismissed(true)}
          >
            <Text as="p">{error}</Text>
          </Banner>
        )}

        {/* ── Delivery-sync issue banner (ADR-22): failed/stuck webhook syncs.
            Not dismissible on purpose — it reports a real capacity-count gap
            and disappears on its own once the sync completes. ───────────── */}
        {loaderData.syncIssues.count > 0 && (
          <Banner
            tone="warning"
            title={`Delivery info has not synced for ${loaderData.syncIssues.count} order${
              loaderData.syncIssues.count === 1 ? "" : "s"
            }`}
            action={{
              content: "Retry sync",
              loading: syncRetryFetcher.state !== "idle",
              onAction: () =>
                syncRetryFetcher.submit(
                  { _action: "retryDeliverySync" },
                  { method: "post" },
                ),
            }}
          >
            <Text as="p">
              {loaderData.syncIssues.orderNames.join(", ")}
              {loaderData.syncIssues.count > loaderData.syncIssues.orderNames.length
                ? " and more"
                : ""}{" "}
              — booked-slot counts may be undercounting these orders until the
              sync completes. Retry runs in the background.
            </Text>
          </Banner>
        )}

        {/* ── Recent customer reschedules (2026-09-04) — on EVERY tab, because
            the moved order has by definition just left the view being looked
            at. Rows clear on Seen or after 48 h; no dismiss on purpose. ──── */}
        <RecentReschedulesBanner
          items={loaderData.recentReschedules}
          pendingSeenIds={pendingSeenIds}
          errorMessage={
            rescheduleSeenFetcher.state === "idle" &&
            rescheduleSeenFetcher.data?.ok === false
              ? rescheduleSeenFetcher.data.message
              : null
          }
          onOpen={openRecentReschedule}
          onSeen={markRescheduleSeen}
          onSeenAll={submitReschedulesSeen}
        />

        {/* ── Search hit hidden by the dated tab / date-slot filter ───────── */}
        {hiddenSearchMatches.length > 0 && (
          <Banner
            tone="info"
            title="No match in this view"
            action={{ content: "Show in All", onAction: showSearchInAll }}
          >
            <Text as="p">
              Found in All:{" "}
              {hiddenSearchMatches.map((m) => `${m.name} · ${m.when}`).join(", ")}
              {orders.length > hiddenSearchMatches.length ? " and more" : ""}.
            </Text>
          </Banner>
        )}

        {/* ── Background bulk-job progress (ADR-22 Phase B) — a large
            selection runs server-side, chunk by chunk; this banner tracks the
            poll until the completion toast fires ─────────────────────────── */}
        {activeJob && (
          <Banner
            tone="info"
            title={`Processing ${activeJob.total} order${
              activeJob.total === 1 ? "" : "s"
            } in the background`}
          >
            <Text as="p">
              {jobProgress && jobProgress.done > 0
                ? `${jobProgress.done} of ${jobProgress.total} processed…`
                : "Starting…"}{" "}
              The job continues on the server even if this page closes — the
              result toast just needs the page open.
            </Text>
          </Banner>
        )}

        {/* ── Background-refresh nudge (§6) — new/changed rows are also badged
            in the table below; dismissing clears the badges ─────────────── */}
        {ordersDiffTitle && (
          <Banner tone="info" title={ordersDiffTitle} onDismiss={dismissOrdersDiff}>
            <Text as="p">
              This view changed since the last refresh — new and updated rows
              are marked in the table below.
            </Text>
          </Banner>
        )}

        {/* ── KPI band — values are computed from the loaded page only (REC-8) ── */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 5 }} gap="300">
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Orders · this page
              </Text>
              <Text as="p" variant="headingLg">
                {kpiOrderCount}
              </Text>
              <InlineStack gap="200" blockAlign="center">
                {tabCounts.today > 0 && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {tabCounts.today} delivering today
                  </Text>
                )}
                <Button
                  variant="plain"
                  onClick={() => setKpiProductsOpen(true)}
                >
                  Items to prepare
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Revenue · this page
              </Text>
              <Text as="p" variant="headingLg">
                {kpiRevenue}
              </Text>
              {kpiAvgRevenue && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {kpiAvgRevenue}
                </Text>
              )}
            </BlockStack>
          </Card>

          <div
            role="button"
            tabIndex={0}
            aria-label="Show unpaid orders"
            onClick={() => handleTabChange("unpaid")}
            onKeyDown={(e) =>
              (e.key === "Enter" || e.key === " ") && handleTabChange("unpaid")
            }
            style={{ cursor: "pointer" }}
          >
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Unpaid · this page
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={kpiUnpaidCount > 0 ? "critical" : undefined}
                >
                  {kpiUnpaidCount}
                </Text>
                {kpiUnpaidTotal && (
                  <Text
                    as="p"
                    variant="bodySm"
                    tone={kpiUnpaidCount > 0 ? "critical" : "subdued"}
                  >
                    {kpiUnpaidTotal}
                  </Text>
                )}
              </BlockStack>
            </Card>
          </div>

          <div
            role="button"
            tabIndex={0}
            aria-label="Show unfulfilled orders"
            onClick={() => handleTabChange("unfulfilled")}
            onKeyDown={(e) =>
              (e.key === "Enter" || e.key === " ") &&
              handleTabChange("unfulfilled")
            }
            style={{ cursor: "pointer" }}
          >
            <Card>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Unfulfilled · this page
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={kpiUnfulfilledCount > 0 ? "critical" : undefined}
                >
                  {kpiUnfulfilledCount}
                </Text>
                {kpiUnfulfilledDueToday > 0 && (
                  <Text as="p" variant="bodySm" tone="critical">
                    {kpiUnfulfilledDueToday} due today or earlier
                  </Text>
                )}
              </BlockStack>
            </Card>
          </div>

          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Delivery Fees · this page
              </Text>
              <Text as="p" variant="headingLg">
                {kpiDeliveryFees}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        {/* ── Filters + table ───────────────────────────────────────────────── */}
        <BlockStack gap="200">
          <InlineStack align="end" gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              {lastUpdatedLabel}
            </Text>
            <Button
              variant="plain"
              onClick={refresh}
              loading={isRefreshing}
              accessibilityLabel="Refresh orders"
            >
              Refresh
            </Button>
          </InlineStack>
          <Card padding="0">
          <OrdersIndexTable
            orders={displayedOrders}
            todayISO={dateRefs.todayISO}
            loading={loading}
            isSubmitting={isSubmitting}
            hasNextPage={pageInfo?.hasNextPage || false}
            hasPreviousPage={pageInfo?.hasPreviousPage || false}
            onNextPage={handleNextPage}
            onPreviousPage={handlePreviousPage}
            tabs={tabDefs}
            activeTab={tabParam}
            onTabChange={handleTabChange}
            queryValue={searchTerm}
            onQueryChange={setSearchTerm}
            onQueryClear={handleQueryClear}
            deliveryDateFilter={deliveryDateFilter}
            onDeliveryDateChange={handleDateChange}
            timeWindow={timeWindowParam}
            onTimeWindowChange={handleTimeWindowChange}
            sortSelected={sortParam}
            onSortChange={handleSortChange}
            onClearFilters={handleClearFilters}
            hasActiveFilters={hasActiveFilters}
            selectedResources={selectedResources}
            allResourcesSelected={allResourcesSelected}
            onSelectionChange={handleSelectionChange}
            onOpenOrder={openOrderPanel}
            onShowTags={(orderId) => setTagsModalOrderId(orderId)}
            onOpenBulkModal={openModal}
            newOrderIds={newOrderIds}
            changedOrderIds={changedOrderIds}
          />
          </Card>
        </BlockStack>
      </BlockStack>

      {/* ── Bulk-action modals — visibility driven by useBulkActions state ──── */}
      <CancelModal
        open={activeModal === "cancel"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        cancelReason={cancelReason}
        setCancelReason={setCancelReason}
        cancelRestock={cancelRestock}
        setCancelRestock={setCancelRestock}
        cancelNotify={cancelNotify}
        setCancelNotify={setCancelNotify}
        cancelStaffNote={cancelStaffNote}
        setCancelStaffNote={setCancelStaffNote}
        onConfirm={handleCancelConfirm}
      />
      <ArchiveModal
        open={activeModal === "archive"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        onConfirm={handleArchiveConfirm}
      />
      <UnarchiveModal
        open={activeModal === "unarchive"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        onConfirm={handleUnarchiveConfirm}
      />
      <MarkFulfilledModal
        open={activeModal === "markFulfilled"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        fulfillTrackingUrl={fulfillTrackingUrl}
        setFulfillTrackingUrl={setFulfillTrackingUrl}
        fulfillNotify={fulfillNotify}
        setFulfillNotify={setFulfillNotify}
        fulfillLalamoveOrderId={fulfillLalamoveOrderId}
        setFulfillLalamoveOrderId={setFulfillLalamoveOrderId}
        onConfirm={handleMarkFulfilled}
      />
      <RescheduleModal
        open={activeModal === "reschedule"}
        onClose={closeModal}
        targets={rescheduleTargets}
        isSubmitting={isSubmitting}
        rules={rescheduleRulesFetcher.data ?? null}
        rulesLoading={rescheduleRulesFetcher.state !== "idle"}
        serverCapacity={rescheduleServerCapacity}
        onConfirm={(date, timeSlot, override, notifyCustomer) =>
          submitReschedule(
            panelRescheduleIds ?? selectedResources,
            date,
            timeSlot,
            override,
            notifyCustomer,
          )
        }
      />
      <SendEmailModal
        open={activeModal === "sendEmail" && selectedOrder !== null}
        onClose={closeModal}
        orderId={selectedOrder?.id ?? null}
        orderName={selectedOrder?.name ?? null}
        customerEmail={
          selectedOrder?.customer?.defaultEmailAddress?.emailAddress ?? null
        }
      />
      <EditDetailsModal
        open={activeModal === "editDetails" && selectedOrder !== null}
        onClose={closeModal}
        order={selectedOrder}
        mapsApiKey={loaderData.mapsApiKey}
      />
      <AddTagsModal
        open={activeModal === "addTags"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        addTagsInput={addTagsInput}
        setAddTagsInput={setAddTagsInput}
        onConfirm={handleAddTags}
      />
      <RemoveTagsModal
        open={activeModal === "removeTags"}
        onClose={closeModal}
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        removeTagsInput={removeTagsInput}
        setRemoveTagsInput={setRemoveTagsInput}
        suggestedTags={removeTagSuggestions}
        onConfirm={handleRemoveTags}
      />
      <KpiProductsModal
        open={kpiProductsOpen}
        onClose={() => setKpiProductsOpen(false)}
        kpiProducts={kpiProducts}
      />
      <SharedTagsModal
        open={tagsModalOrderId !== null}
        onClose={() => setTagsModalOrderId(null)}
        tags={sharedTagsModalTags}
      />

      {/* ── Right-side order details panel (URL-driven, ?order=) ───────────── */}
      {selectedOrder && (
        <Suspense fallback={null}>
          <OrderDetailsPanel
            order={selectedOrder}
            todayISO={dateRefs.todayISO}
            notInView={selectedOrderNotInView}
            escDisabled={anyModalOpen}
            onClose={handleCloseDrawer}
            onReschedule={openPanelReschedule}
            onSendEmail={openPanelSendEmail}
            onEditDetails={openPanelEditDetails}
          />
        </Suspense>
      )}
    </Page>
  );
}

export default Extension;
