import { useState, useCallback, useMemo, useEffect, useRef, type ChangeEvent } from "react";
import { OrderDrawer } from "../components/OrderDrawer";
import {
  type Order,
  type CustomAttribute,
  type BadgeTone,
  parseTimeWindowHour,
  parseDateValue,
  toLocalISODate,
  normalizeDateToISO,
  normalizeTimeSlot,
  formatDeliveryDate,
  formatMoney,
  DATE_ISO_RE,
  TIME_SLOT_RE,
  financialStatusTone,
  isUnpaidStatus,
  fulfillmentStatusTone,
  isOpenFulfillmentStatus,
  formatStatusLabel,
  isHiddenDateTag,
  isHiddenTag,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  findAttrValue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getOrderPhone,
  getCity,
  getInstructionValue,
  getSearchableOrderText,
  getFirstItemImageUrl,
  getFirstItemAltText,
} from "../lib/order-utils";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useFetcher,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import stylesHref from "../styles/orders-dashboard.css?url";

export const links = () => [{ rel: "stylesheet", href: stylesHref }];

// ─── Sorting ─────────────────────────────────────────────────────────────────

type SortableColumn = "city" | "timeWindow" | "deliveryDate" | "fulfillment";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortableColumn | null;
  direction: SortDirection;
}

const FULFILLMENT_ORDER: Record<string, number> = {
  UNFULFILLED: 0,
  ON_HOLD: 1,
  SCHEDULED: 2,
  IN_PROGRESS: 3,
  PARTIALLY_FULFILLED: 4,
  FULFILLED: 5,
  RESTOCKED: 6,
};

const DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "items",
  "customer",
  "city",
  "payment",
  "fulfillment",
  "deliveryDate",
  "timeWindow",
  "total",
];

const MOBILE_VISIBLE_COLUMNS = [
  "name",
  "customer",
  "city",
  "deliveryDate",
  "timeWindow",
  "fulfillment",
];

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
  ) {
    orders(
      first: $first
      after: $after
      last: $last
      before: $before
      query: $query
      sortKey: CREATED_AT
      reverse: true
    ) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
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
          paymentGatewayNames
          lalamoveOrderId: metafield(namespace: "lalamove", key: "order_id") {
            value
          }
          lalamoveStatus: metafield(namespace: "lalamove", key: "status") {
            value
          }
          lalamoveShareLink: metafield(namespace: "lalamove", key: "share_link") {
            value
          }
          lalamoveDriverName: metafield(namespace: "lalamove", key: "driver_name") {
            value
          }
          lalamoveDriverPhone: metafield(namespace: "lalamove", key: "driver_phone") {
            value
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

// ─── Sortable column header ──────────────────────────────────────────────────

interface SortableHeaderProps {
  id: string;
  column: SortableColumn;
  label: string;
  sortState: SortState;
  onSort: (col: SortableColumn) => void;
  listSlot?: TableListSlot;
}

type TableListSlot = "primary" | "secondary" | "kicker" | "inline" | "labeled";

function SortableHeader({
  id,
  column,
  label,
  sortState,
  onSort,
  listSlot,
}: SortableHeaderProps) {
  const isActive: boolean = sortState.column === column;
  const iconType = isActive
    ? sortState.direction === "asc"
      ? "sort-ascending"
      : "sort-descending"
    : "sort";
  return (
    <s-table-header id={id} listSlot={listSlot}>
      <s-button
        id={`sort-btn-${column}`}
        variant="tertiary"
        icon={iconType}
        onClick={() => onSort(column)}
        accessibilityLabel={`Sort by ${label}`}
      >
        {label}
      </s-button>
    </s-table-header>
  );
}

// ─── Runtime safety helpers ───────────────────────────────────────────────────

function getSafeEventValue(e: Event): string {
  const t = (e.currentTarget ?? e.target) as
    | (EventTarget & { value?: unknown })
    | null;
  const detailValue = (e as Event & { detail?: { value?: unknown } }).detail
    ?.value;
  return (
    (typeof t?.value === "string" ? t.value : null) ??
    (typeof detailValue === "string" ? detailValue : null) ??
    ""
  );
}

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

// ─── Loader ───────────────────────────────────────────────────────────────────

type LoaderData = {
  orders: Order[];
  pageInfo: PageInfo | null;
  errors: Array<{ message: string }> | null;
  deliveryDateParam: string | null;
  searchParam: string;
  timeWindowParam: string;
  tabParam: string;
};

export const loader = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const rawDeliveryDateParam = url.searchParams.get("deliveryDate");
  const deliveryDateParam = isIsoDateParam(rawDeliveryDateParam)
    ? rawDeliveryDateParam
    : null;

  const searchParam = url.searchParams.get("search")?.trim() ?? "";
  const timeWindowParam = url.searchParams.get("timeWindow")?.trim() ?? "";
  const tabParam = url.searchParams.get("tab") ?? "all";

  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  // Build composite Shopify query string from all active filters
  const queryParts: string[] = [];

  if (deliveryDateParam) {
    queryParts.push(`metafields.custom.date:${deliveryDateParam}`);
  }
  if (searchParam) {
    queryParts.push(searchParam);
  }
  if (timeWindowParam) {
    queryParts.push(`metafields.custom.time_slot:${timeWindowParam}`);
  }
  if (tabParam === "unfulfilled") {
    queryParts.push("fulfillment_status:unfulfilled");
  } else if (tabParam === "unpaid") {
    queryParts.push(
      "financial_status:pending OR financial_status:authorized OR financial_status:partially_paid",
    );
  } else if (tabParam === "today") {
    const todayISO = new Date().toLocaleDateString("en-CA");
    queryParts.push(`metafields.custom.date:${todayISO}`);
  } else if (tabParam === "tomorrow") {
    const tom = new Date();
    tom.setDate(tom.getDate() + 1);
    queryParts.push(`metafields.custom.date:${tom.toLocaleDateString("en-CA")}`);
  }
  // "thisWeek" and "all" tabs: no server-side date fragment; client filters thisWeek

  const compositeQuery = queryParts.join(" ") || null;

  // thisWeek tab needs more orders since client must filter by date range
  const pageSize = tabParam === "thisWeek" ? 250 : 25;

  const variables = {
    first: before ? null : pageSize,
    after,
    last: before ? pageSize : null,
    before,
    query: compositeQuery,
  };

  const response = await admin.graphql(GET_ORDERS_QUERY, { variables });
  const body = (await response.json()) as {
    data?: {
      orders?: {
        edges?: Array<{ node: Order }>;
        pageInfo?: PageInfo | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  return Response.json(
    {
      orders:
        body.data?.orders?.edges?.map((edge: { node: Order }) => edge.node) ??
        [],
      pageInfo: body.data?.orders?.pageInfo ?? null,
      errors: body.errors ?? null,
      deliveryDateParam,
      searchParam,
      timeWindowParam,
      tabParam,
    } satisfies LoaderData,
    { headers: { "Cache-Control": "no-store" } },
  );
};

// ─── Bulk action mutations ────────────────────────────────────────────────────

const ORDER_CLOSE_MUTATION = `
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_OPEN_MUTATION = `
  mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $restock: Boolean!
    $notifyCustomer: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job { id }
      orderCancelUserErrors { field message code }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// Fulfillment-order workflow — used ONLY when the merchant clicks "Mark as fulfilled".
// Requires read_merchant_managed_fulfillment_orders (query) and
// write_merchant_managed_fulfillment_orders (mutation). Never added to GET_ORDERS_QUERY.
// Builds one aliased query for all selected orders to replace N serial API roundtrips.
function buildBatchFulfillmentQuery(ids: string[]): string {
  const fragments = ids
    .map(
      (id, i) =>
        `  o${i}: order(id: "${id}") {
    id
    fulfillmentOrders(first: 50) {
      nodes {
        id
        status
        supportedActions { action }
      }
    }
  }`,
    )
    .join("\n");
  return `query BatchFulfillmentOrders {\n${fragments}\n}`;
}

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const STAGED_UPLOADS_CREATE_MUTATION = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE_MUTATION = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        ... on MediaImage {
          image { url }
        }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_UPDATE_METAFIELD_MUTATION = `
  mutation OrderUpdateMetafield($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

// Rewrite raw Shopify access-denied / scope errors into something the merchant can act on.
function scopeHint(msg: string): string {
  if (
    /access denied|fulfillmentOrders|not authorized|missing.*scope/i.test(msg)
  ) {
    return "Access denied — the app needs fulfillment-order permission. Please reinstall the app to grant the new scope.";
  }
  return msg;
}

async function uploadBouquetPhoto(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  file: File,
): Promise<string> {
  const stagedRes = await admin.graphql(STAGED_UPLOADS_CREATE_MUTATION, {
    variables: {
      input: [
        {
          resource: "FILE",
          filename: file.name,
          mimeType: file.type,
          httpMethod: "POST",
          fileSize: String(file.size),
        },
      ],
    },
  });
  const stagedJson = (await stagedRes.json()) as {
    data?: {
      stagedUploadsCreate?: {
        stagedTargets: Array<{
          url: string;
          resourceUrl: string;
          parameters: Array<{ name: string; value: string }>;
        }>;
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const stagingErrors = stagedJson.data?.stagedUploadsCreate?.userErrors;
  if (stagingErrors?.length) {
    throw new Error(`Staged upload failed: ${stagingErrors.map((e) => e.message).join("; ")}`);
  }
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Staged upload returned no target URL.");

  const uploadForm = new FormData();
  for (const { name, value } of target.parameters) {
    uploadForm.append(name, value);
  }
  uploadForm.append("file", file);
  const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadRes.ok) throw new Error(`Photo upload failed (HTTP ${uploadRes.status}).`);

  const fileRes = await admin.graphql(FILE_CREATE_MUTATION, {
    variables: {
      files: [{ originalSource: target.resourceUrl, contentType: "IMAGE" }],
    },
  });
  const fileJson = (await fileRes.json()) as {
    data?: {
      fileCreate?: {
        files: Array<{ image?: { url: string } }>;
        userErrors: Array<{ message: string }>;
      };
    };
  };
  const fileErrors = fileJson.data?.fileCreate?.userErrors;
  if (fileErrors?.length) {
    throw new Error(`File creation failed: ${fileErrors.map((e) => e.message).join("; ")}`);
  }
  const url = fileJson.data?.fileCreate?.files?.[0]?.image?.url;
  if (!url) throw new Error("File created but URL was not returned.");
  return url;
}

// ─── Action result types ──────────────────────────────────────────────────────

type BulkActionName =
  | "archive"
  | "unarchive"
  | "cancel"
  | "tagsAdd"
  | "tagsRemove"
  | "markFulfilled";

const BULK_ACTION_NAMES: readonly BulkActionName[] = [
  "archive",
  "unarchive",
  "cancel",
  "tagsAdd",
  "tagsRemove",
  "markFulfilled",
];
const MAX_SELECTED_ORDER_IDS = 100;
const MAX_TAG_LENGTH = 255;

function isBulkActionName(value: string): value is BulkActionName {
  return (BULK_ACTION_NAMES as readonly string[]).includes(value);
}

interface BulkActionItemResult {
  orderId: string;
  success: boolean;
  message?: string;
}

interface BulkActionResponse {
  ok: boolean;
  action: BulkActionName | null;
  message?: string;
  results: BulkActionItemResult[];
  summary: { ok: number; failed: number };
}

// ─── Action handler ───────────────────────────────────────────────────────────

export const action = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin } = await authenticate.admin(request);
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

  const results: BulkActionItemResult[] = [];

  const runOne = async (
    id: string,
    mutation: string,
    variables: Record<string, unknown>,
    rootKey: string,
    errorsKey: "userErrors" | "orderCancelUserErrors",
  ) => {
    try {
      const res = await admin.graphql(mutation, { variables });
      const j = (await res.json()) as {
        data?: Record<string, { [k: string]: unknown }>;
        errors?: Array<{ message: string }>;
      };
      if (j.errors?.length) {
        results.push({
          orderId: id,
          success: false,
          message: j.errors.map((e) => e.message).join("; "),
        });
        return;
      }
      const errs =
        (j?.data?.[rootKey]?.[errorsKey] as Array<{ message: string }>) || [];
      if (errs.length) {
        results.push({
          orderId: id,
          success: false,
          message: errs.map((e) => e.message).join("; "),
        });
      } else {
        results.push({ orderId: id, success: true });
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "GraphQL error";
      results.push({ orderId: id, success: false, message });
    }
  };

  if (op === "archive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_CLOSE_MUTATION,
        { input: { id } },
        "orderClose",
        "userErrors",
      );
    }
  } else if (op === "unarchive") {
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_OPEN_MUTATION,
        { input: { id } },
        "orderOpen",
        "userErrors",
      );
    }
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
    const staffNote = staffNoteRaw.trim() || null;
    for (const id of orderIds) {
      await runOne(
        id,
        ORDER_CANCEL_MUTATION,
        { orderId: id, reason, restock, notifyCustomer, staffNote },
        "orderCancel",
        "orderCancelUserErrors",
      );
    }
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
    const mutation =
      op === "tagsAdd" ? TAGS_ADD_MUTATION : TAGS_REMOVE_MUTATION;
    const rootKey = op === "tagsAdd" ? "tagsAdd" : "tagsRemove";
    for (const id of orderIds) {
      await runOne(id, mutation, { id, tags }, rootKey, "userErrors");
    }
  } else if (op === "markFulfilled") {
    const trackingNumber = String(fd.get("trackingNumber") || "").trim();
    const trackingUrl = String(fd.get("trackingUrl") || "").trim();
    const notifyCustomer = fd.get("notifyCustomer") === "1";
    if (trackingUrl && !isHttpTrackingUrl(trackingUrl)) {
      return Response.json(
        {
          ...empty,
          message: "Tracking URL must start with http:// or https://.",
        },
        { status: 400 },
      );
    }

    const bouquetPhotoFile =
      fd.get("bouquetPhoto") instanceof File
        ? (fd.get("bouquetPhoto") as File)
        : null;
    const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
    if (bouquetPhotoFile && bouquetPhotoFile.size > MAX_PHOTO_BYTES) {
      return Response.json(
        { ...empty, message: "Bouquet photo must be 5 MB or smaller." },
        { status: 400 },
      );
    }

    let bouquetPhotoUrl: string | null = null;
    let photoUploadWarning: string | null = null;
    if (bouquetPhotoFile && bouquetPhotoFile.size > 0) {
      try {
        bouquetPhotoUrl = await uploadBouquetPhoto(admin, bouquetPhotoFile);
      } catch (e: unknown) {
        photoUploadWarning = e instanceof Error ? e.message : "Photo upload failed.";
      }
    }

    // ── Step 1: Batch-fetch fulfillment orders (single API call) ─────────────
    const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;
    const safeIds = orderIds.filter((id) => SHOPIFY_ORDER_GID_RE.test(id));
    for (const id of orderIds) {
      if (!SHOPIFY_ORDER_GID_RE.test(id)) {
        results.push({ orderId: id, success: false, message: "Invalid order ID." });
      }
    }

    type FulfillmentNode = {
      id: string;
      status: string;
      supportedActions?: Array<{ action: string }>;
    };
    const fulfillableByOrderId = new Map<string, FulfillmentNode[]>();
    let batchQueryFailed = false;

    if (safeIds.length > 0) {
      const batchQuery = buildBatchFulfillmentQuery(safeIds);
      let batchJson: {
        data?: Record<string, {
          id: string;
          fulfillmentOrders: { nodes: FulfillmentNode[] };
        } | null>;
        errors?: Array<{ message: string }>;
      } = {};
      try {
        const batchRes = await admin.graphql(batchQuery);
        batchJson = await batchRes.json();
      } catch (e: unknown) {
        batchQueryFailed = true;
        const m =
          e instanceof Error ? e.message : "Failed to read fulfillment orders";
        for (const id of safeIds) {
          results.push({ orderId: id, success: false, message: scopeHint(m) });
        }
      }

      if (!batchQueryFailed) {
        if (batchJson.errors?.length) {
          batchQueryFailed = true;
          const msg = batchJson.errors.map((e) => e.message).join("; ");
          for (const id of safeIds) {
            results.push({ orderId: id, success: false, message: scopeHint(msg) });
          }
        } else {
          safeIds.forEach((id, i) => {
            const orderData = batchJson.data?.[`o${i}`];
            fulfillableByOrderId.set(
              id,
              (orderData?.fulfillmentOrders?.nodes ?? []).filter((n) =>
                (n.supportedActions || []).some(
                  (a) => a.action === "CREATE_FULFILLMENT",
                ),
              ),
            );
          });
        }
      }
    }

    // ── Step 2: Create fulfillments (one mutation per order) ─────────────────
    if (!batchQueryFailed) {
      for (const id of safeIds) {
        const fulfillable = fulfillableByOrderId.get(id) ?? [];
        if (fulfillable.length === 0) {
          results.push({
            orderId: id,
            success: false,
            message: "No fulfillable items remaining.",
          });
          continue;
        }

        const fulfillment: Record<string, unknown> = {
          lineItemsByFulfillmentOrder: fulfillable.map((fo) => ({
            fulfillmentOrderId: fo.id,
          })),
          notifyCustomer,
        };
        if (trackingNumber || trackingUrl) {
          const trackingInfo: Record<string, string> = {};
          if (trackingNumber) trackingInfo.number = trackingNumber;
          if (trackingUrl) trackingInfo.url = trackingUrl;
          fulfillment.trackingInfo = trackingInfo;
        }

        const before = results.length;
        await runOne(
          id,
          FULFILLMENT_CREATE_MUTATION,
          { fulfillment },
          "fulfillmentCreate",
          "userErrors",
        );
        for (let i = before; i < results.length; i++) {
          const r = results[i];
          if (!r.success && r.message) r.message = scopeHint(r.message);
          if (r.success && photoUploadWarning) {
            r.message = `Fulfilled. Note: photo upload failed — ${photoUploadWarning}`;
          }
        }

        if (bouquetPhotoUrl) {
          try {
            await admin.graphql(ORDER_UPDATE_METAFIELD_MUTATION, {
              variables: {
                input: {
                  id,
                  metafields: [
                    {
                      namespace: "custom",
                      key: "bouquet_photo",
                      type: "single_line_text_field",
                      value: bouquetPhotoUrl,
                    },
                  ],
                },
              },
            });
          } catch {
            // non-fatal — fulfillment already processed
          }
        }
      }
    }
  } else {
    return Response.json(
      { ...empty, message: "Unknown action." },
      { status: 400 },
    );
  }

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
  | "tomorrow"
  | "thisWeek"
  | "unfulfilled"
  | "unpaid";

// ─── useFilteredSelection ─────────────────────────────────────────────────────

function useFilteredSelection(
  displayedOrders: Order[],
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  useEffect(() => {
    const visibleIds = new Set(displayedOrders.map((o) => o.id));
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const pruned = new Set([...prev].filter((id) => visibleIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [displayedOrders, setSelectedIds]);
}

// ─── Main Extension ───────────────────────────────────────────────────────────

function Extension() {
  const loaderData = useLoaderData() as LoaderData;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const shopify = useAppBridge();

  const orders = loaderData.orders;
  const pageInfo = loaderData.pageInfo;
  const loading = navigation.state === "loading";
  const deliveryDateFilter = loaderData.deliveryDateParam || "";

  // URL-driven filter params (from loader — always in sync with what the server fetched)
  const searchParam = loaderData.searchParam;
  const timeWindowParam = loaderData.timeWindowParam;
  const tabParam = loaderData.tabParam as ActiveTab;

  const [error] = useState<string | null>(
    loaderData.errors
      ? loaderData.errors.map((e) => e.message).join(", ")
      : null,
  );
  const [errorDismissed, setErrorDismissed] = useState<boolean>(false);

  // Local draft for the search input — debounced to URL via useEffect
  const [searchTerm, setSearchTerm] = useState<string>(searchParam);
  const searchParamRef = useRef(searchParam);

  // Sort state
  const [sortState, setSortState] = useState<SortState>({
    column: null,
    direction: "asc",
  });

  // Row selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Right-side drawer state — store only the ID so the drawer always reflects fresh loader data
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

  // Shared tags modal state — single modal instance reused for all rows
  const [tagsModalOrderId, setTagsModalOrderId] = useState<string | null>(null);
  const [tagsModalTrigger, setTagsModalTrigger] = useState(0);

  // Column visibility state
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(DEFAULT_VISIBLE_COLUMNS),
  );

  const handleCloseDrawer = useCallback(() => setSelectedOrderId(null), []);

  const handleDrawerMarkFulfilled = useCallback(() => {
    if (!selectedOrderId) return;
    setSelectedIds(new Set([selectedOrderId]));
    showModal("modal-mark-fulfilled");
  }, [selectedOrderId]);

  const showTagsModal = useCallback((orderId: string) => {
    setTagsModalOrderId(orderId);
    setTagsModalTrigger((n) => n + 1);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const handleResize = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setVisibleColumns(new Set(MOBILE_VISIBLE_COLUMNS));
      } else {
        setVisibleColumns(new Set(DEFAULT_VISIBLE_COLUMNS));
      }
    };
    handleResize(mediaQuery); // Run immediately
    mediaQuery.addEventListener("change", handleResize); // Listen for resizes
    return () => mediaQuery.removeEventListener("change", handleResize);
  }, []);

  // Clear selection when tab changes (tabParam is URL-driven)
  useEffect(() => {
    setSelectedIds(new Set());
  }, [tabParam]);

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

  useEffect(() => {
    if (tagsModalTrigger > 0) {
      const el = document.getElementById("modal-tags-shared") as
        | (HTMLElement & { show?: () => void })
        | null;
      if (el && typeof el.show === "function") el.show();
      else el?.setAttribute("open", "");
    }
  }, [tagsModalTrigger]);

  const subtitleDate = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );

  // Stable date references for tab filtering (computed once per mount)
  const dateRefs = useMemo(() => {
    const now = new Date();
    const todayISO = toLocalISODate(now);
    const tom = new Date(now);
    tom.setDate(now.getDate() + 1);
    const tomorrowISO = toLocalISODate(tom);
    const dow = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      todayISO,
      tomorrowISO,
      startWeekISO: toLocalISODate(monday),
      endWeekISO: toLocalISODate(sunday),
    };
  }, []);

  const handleToggleColumn = (colId: string, checked: boolean) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (checked) next.add(colId);
      else next.delete(colId);
      return next;
    });
  };

  // ── Search handler ─────────────────────────────────────────────────────────

  const handleSearchInput = (e: Event): void => {
    setSearchTerm(getSafeEventValue(e));
  };

  // ── Sort handler ───────────────────────────────────────────────────────────

  const handleSort = useCallback((col: SortableColumn): void => {
    setSortState((prev) => ({
      column: col,
      direction:
        prev.column === col && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  // ── Tab handler — navigates to ?tab=VALUE and clears cursors ────────────────

  const handleTabChange = useCallback(
    (tab: ActiveTab): void => {
      const params = new URLSearchParams(searchParams);
      if (tab === "all") {
        params.delete("tab");
      } else {
        params.set("tab", tab);
      }
      params.delete("after");
      params.delete("before");
      setSelectedIds(new Set());
      navigate(`?${params.toString()}`, { replace: true });
    },
    [searchParams, navigate],
  );

  // ── Filter handlers ─────────────────────────────────────────────────────────

  const handleDateChange = (value: string): void => {
    const iso = normalizeDateToISO(value);
    const params = new URLSearchParams(searchParams);
    if (iso) {
      params.set("deliveryDate", iso);
    } else {
      params.delete("deliveryDate");
    }
    params.delete("after");
    params.delete("before");
    setSelectedIds(new Set());
    navigate(`?${params.toString()}`, { replace: true });
  };

  const handleClearFilters = (): void => {
    const params = new URLSearchParams(searchParams);
    params.delete("search");
    params.delete("tab");
    params.delete("timeWindow");
    params.delete("deliveryDate");
    params.delete("after");
    params.delete("before");
    setSearchTerm("");
    setSelectedIds(new Set());
    setSortState({ column: null, direction: "asc" });
    navigate(`?${params.toString()}`, { replace: true });
  };

  // ── Row selection handlers ─────────────────────────────────────────────────

  const handleToggleRow = (id: string, checked: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleToggleAll = (checked: boolean): void => {
    if (checked) {
      setSelectedIds(new Set(displayedOrders.map((o) => o.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleClearSelection = (): void => {
    setSelectedIds(new Set());
  };

  // ── Pagination handlers — update URL cursors to trigger loader refetch ───────

  const handleNextPage = (): void => {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("after", pageInfo.endCursor);
    params.delete("before");
    navigate(`?${params.toString()}`, { replace: true });
  };

  const handlePreviousPage = (): void => {
    if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("before", pageInfo.startCursor);
    params.delete("after");
    navigate(`?${params.toString()}`, { replace: true });
  };

  // ── Client-side filter — only thisWeek needs local date-range filtering;
  //    all other filters are handled server-side via GraphQL query param ──────

  const filteredOrders: Order[] = useMemo(() => {
    if (tabParam !== "thisWeek") return orders;
    return orders.filter((order) => {
      const d = getDeliveryDateValue(order);
      return (
        d !== "—" &&
        d >= dateRefs.startWeekISO &&
        d <= dateRefs.endWeekISO
      );
    });
  }, [orders, tabParam, dateRefs]);

  const displayedOrders: Order[] = useMemo(() => {
    if (!sortState.column) return filteredOrders;
    return [...filteredOrders].sort((a, b) => {
      let cmp = 0;
      switch (sortState.column) {
        case "timeWindow": {
          const ta = getDeliveryTimeValue(a);
          const tb = getDeliveryTimeValue(b);
          cmp = parseTimeWindowHour(ta) - parseTimeWindowHour(tb);
          break;
        }
        case "deliveryDate": {
          const da = parseDateValue(getDeliveryDateValue(a));
          const db = parseDateValue(getDeliveryDateValue(b));
          cmp = da - db;
          break;
        }
        case "fulfillment": {
          const fa =
            FULFILLMENT_ORDER[a.displayFulfillmentStatus?.toUpperCase()] ?? 99;
          const fb =
            FULFILLMENT_ORDER[b.displayFulfillmentStatus?.toUpperCase()] ?? 99;
          cmp = fa - fb;
          break;
        }
        case "city": {
          const ca = getCity(a).toLowerCase();
          const cb = getCity(b).toLowerCase();
          cmp = ca.localeCompare(cb);
          break;
        }
      }
      return sortState.direction === "asc" ? cmp : -cmp;
    });
  }, [filteredOrders, sortState]);

  useFilteredSelection(displayedOrders, setSelectedIds);

  // Selection derived values
  const selectedCount: number = selectedIds.size;
  const allSelected: boolean =
    displayedOrders.length > 0 &&
    displayedOrders.every((o) => selectedIds.has(o.id));
  const someSelected: boolean = selectedCount > 0 && !allSelected;

  // ── KPI computations ────────────────────────────────────────────────────────

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
    const count = displayedOrders.filter(
      (o) => o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
    ).length;
    const dueToday = displayedOrders.filter((o) => {
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

  const { kpiTotalQuantity, kpiProducts } = useMemo(() => {
    if (displayedOrders.length === 0)
      return { kpiTotalQuantity: "—", kpiProducts: [] as [string, number][] };
    let total = 0;
    const productMap = new Map<string, number>();

    for (const o of displayedOrders) {
      if (o.cancelledAt) continue; // F07: cancelled orders do not contribute to products to prepare
      const items = o.lineItems?.edges || [];
      for (const item of items) {
        const qty = item.node.quantity || 0;
        total += qty;
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
      kpiTotalQuantity: String(total), // F06: always show the real counted total
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

  // ── Tab counts (for badge pills) ──────────────────────────────────────────

  const tabCounts = useMemo(() => {
    return {
      today: orders.filter((o) => getDeliveryDateValue(o) === dateRefs.todayISO)
        .length,
      tomorrow: orders.filter(
        (o) => getDeliveryDateValue(o) === dateRefs.tomorrowISO,
      ).length,
      thisWeek: orders.filter((o) => {
        const d = getDeliveryDateValue(o);
        return (
          d !== "—" && d >= dateRefs.startWeekISO && d <= dateRefs.endWeekISO
        );
      }).length,
      unfulfilled: orders.filter(
        (o) => o.displayFulfillmentStatus?.toUpperCase() === "UNFULFILLED",
      ).length,
      unpaid: orders.filter((o) => isUnpaidStatus(o.displayFinancialStatus))
        .length,
    };
  }, [orders, dateRefs]);

  // ── Export for Lalamove ──────────────────────────────────────────────────────

  const exportForLalamove = (): void => {
    const selectedOrders = displayedOrders.filter((o) => selectedIds.has(o.id));
    const headers = [
      '"1. Address"',
      '"2. Name"',
      '"3. Phone"',
      '"4. Block/floor"',
    ];
    const rows = selectedOrders.map((order) => {
      const addr = order.shippingAddress;
      const address = addr?.address1 || "";
      const name = getCustomerName(order);
      const phone = getOrderPhone(order);
      const blockFloor = [addr?.address2, addr?.city]
        .filter(Boolean)
        .join(", ");
      return [
        `"${address.replace(/"/g, '""')}"`,
        `"${name.replace(/"/g, '""')}"`,
        `"${phone.replace(/"/g, '""')}"`,
        `"${blockFloor.replace(/"/g, '""')}"`,
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const today = toLocalISODate(new Date());
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lalamove-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Bulk actions (archive / unarchive / cancel / tags) ─────────────────────

  const fetcher = useFetcher<BulkActionResponse>();
  const isSubmitting: boolean = fetcher.state !== "idle";


  // Cancel modal form state
  const [cancelReason, setCancelReason] = useState<string>("CUSTOMER");
  const [cancelRestock, setCancelRestock] = useState<boolean>(false);
  const [cancelNotify, setCancelNotify] = useState<boolean>(false);
  const [cancelStaffNote, setCancelStaffNote] = useState<string>("");

  // Tag modal form state
  const [addTagsInput, setAddTagsInput] = useState<string>("");
  const [removeTagsInput, setRemoveTagsInput] = useState<string>("");

  // Mark as fulfilled modal form state
  const [fulfillTrackingNumber, setFulfillTrackingNumber] =
    useState<string>("");
  const [fulfillTrackingUrl, setFulfillTrackingUrl] = useState<string>("");
  const [fulfillNotify, setFulfillNotify] = useState<boolean>(false);
  const [fulfillPhotoFile, setFulfillPhotoFile] = useState<File | null>(null);
  const [fulfillPhotoPreview, setFulfillPhotoPreview] = useState<string>("");
  const [fulfillPhotoError, setFulfillPhotoError] = useState<string>("");

  const hideModal = (id: string) => {
    const el = document.getElementById(id) as
      | (HTMLElement & { hide?: () => void })
      | null;
    if (!el) return;
    if (typeof el.hide === "function") el.hide();
    else el.removeAttribute("open");
  };

  const showModal = (id: string) => {
    const el = document.getElementById(id) as
      | (HTMLElement & { show?: () => void })
      | null;
    if (!el) return;
    if (typeof el.show === "function") el.show();
    else el.setAttribute("open", "");
  };

  const submitBulk = useCallback(
    (op: BulkActionName, extras?: Record<string, string>) => {
      if (selectedIds.size === 0) return;
      const fd = new FormData();
      fd.append("_action", op);
      selectedIds.forEach((id) => fd.append("orderId", id));
      if (extras) {
        for (const [k, v] of Object.entries(extras)) fd.append(k, v);
      }
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher, selectedIds],
  );

  const handleArchive = () => showModal("modal-archive-orders");
  const handleUnarchive = () => showModal("modal-unarchive-orders");
  const handleArchiveConfirm = () => submitBulk("archive");
  const handleUnarchiveConfirm = () => submitBulk("unarchive");

  const handleCancelConfirm = () => {
    submitBulk("cancel", {
      reason: cancelReason,
      restock: cancelRestock ? "1" : "0",
      notifyCustomer: cancelNotify ? "1" : "0",
      staffNote: cancelStaffNote,
    });
  };

  const handleAddTags = () => {
    if (!addTagsInput.trim()) return;
    submitBulk("tagsAdd", { tags: addTagsInput });
  };

  const handleRemoveTags = () => {
    if (!removeTagsInput.trim()) return;
    submitBulk("tagsRemove", { tags: removeTagsInput });
  };

  const handleMarkFulfilled = useCallback(() => {
    if (selectedIds.size === 0) return;
    const fd = new FormData();
    fd.append("_action", "markFulfilled");
    selectedIds.forEach((id) => fd.append("orderId", id));
    fd.append("trackingNumber", fulfillTrackingNumber);
    fd.append("trackingUrl", fulfillTrackingUrl);
    fd.append("notifyCustomer", fulfillNotify ? "1" : "0");
    if (fulfillPhotoFile) fd.append("bouquetPhoto", fulfillPhotoFile);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }, [selectedIds, fetcher, fulfillTrackingNumber, fulfillTrackingUrl, fulfillNotify, fulfillPhotoFile]);

  const handlePhotoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setFulfillPhotoFile(null);
    setFulfillPhotoPreview("");
    setFulfillPhotoError("");
    if (!file) return;
    const MAX = 5 * 1024 * 1024;
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setFulfillPhotoError("Only JPEG, PNG, or WebP images are accepted.");
      return;
    }
    if (file.size > MAX) {
      setFulfillPhotoError("File must be 5 MB or smaller.");
      return;
    }
    setFulfillPhotoFile(file);
    setFulfillPhotoPreview(URL.createObjectURL(file));
  };

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    const d = fetcher.data;
    const actionLabel: Record<BulkActionName, { verb: string; ing: string }> = {
      archive: { verb: "archived", ing: "Archive" },
      unarchive: { verb: "unarchived", ing: "Unarchive" },
      cancel: { verb: "queued for cancellation", ing: "Cancel" },
      tagsAdd: { verb: "updated (tags added)", ing: "Add tags" },
      tagsRemove: { verb: "updated (tags removed)", ing: "Remove tags" },
      markFulfilled: { verb: "marked as fulfilled", ing: "Mark as fulfilled" },
    };
    const meta = d.action ? actionLabel[d.action] : null;

    if (d.ok && d.summary && d.summary.ok > 0) {
      const n = d.summary.ok;
      shopify.toast.show(`${n} ${n === 1 ? "order" : "orders"} ${meta?.verb ?? "updated"}.`);
      setSelectedIds(new Set());
      hideModal("modal-archive-orders");
      hideModal("modal-unarchive-orders");
      hideModal("modal-cancel-orders");
      hideModal("modal-add-tags");
      hideModal("modal-remove-tags");
      hideModal("modal-mark-fulfilled");
      setCancelStaffNote("");
      setAddTagsInput("");
      setRemoveTagsInput("");
      setFulfillTrackingNumber("");
      setFulfillTrackingUrl("");
      setFulfillNotify(false);
      setFulfillPhotoFile(null);
      setFulfillPhotoPreview("");
      setFulfillPhotoError("");
    } else if (d.summary && d.summary.failed > 0) {
      const failed = (d.results || []).filter((r) => !r.success);
      const lines = failed
        .slice(0, 3)
        .map((r) => `${r.orderId.split("/").pop()}: ${r.message ?? "Failed"}`)
        .join(" • ");
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
      const okN = d.summary.ok;
      const failN = d.summary.failed;
      const msg =
        okN > 0
          ? `${okN} succeeded, ${failN} failed. ${lines}${more}`
          : `${meta?.ing ?? "Action"} failed for ${failN} ${failN === 1 ? "order" : "orders"}. ${lines}${more}`;
      shopify.toast.show(msg, { isError: true });
      // Keep only failed orders selected so merchant can retry without re-selecting
      setSelectedIds(new Set(failed.map((r) => r.orderId)));
    } else if (d.message) {
      shopify.toast.show(d.message, { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const sortLabel: string = sortState.column
    ? `${sortState.column === "timeWindow" ? "Time window" : sortState.column === "deliveryDate" ? "Delivery date" : sortState.column === "fulfillment" ? "Fulfillment" : "City"} ${
        sortState.direction === "asc" ? "↑" : "↓"
      }`
    : "Sort";

  const tabDefs: { id: ActiveTab; label: string; count: number }[] = [
    { id: "all", label: "All", count: orders.length },
    { id: "today", label: "Today", count: tabCounts.today },
    { id: "tomorrow", label: "Tomorrow", count: tabCounts.tomorrow },
    { id: "thisWeek", label: "This week", count: tabCounts.thisWeek },
    { id: "unfulfilled", label: "Unfulfilled", count: tabCounts.unfulfilled },
    { id: "unpaid", label: "Unpaid", count: tabCounts.unpaid },
  ];

  const hasActiveFilters = Boolean(
    searchParam ||
    timeWindowParam ||
    deliveryDateFilter ||
    tabParam !== "all",
  );
  const hasActiveViewControls = Boolean(hasActiveFilters || sortState.column);

  return (
    <s-page
      id="orders-dashboard-page"
      heading="Orders Operations"
      inlineSize="large"
    >
      {/* ── Global modals ──────────────────────────────────────────────────── */}

      {/* Sort menu */}
      <s-menu id="sort-menu" accessibilityLabel="Sort orders">
        <s-button
          icon={
            sortState.column === "deliveryDate"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("deliveryDate")}
        >
          Delivery date
          {sortState.column === "deliveryDate"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "timeWindow"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("timeWindow")}
        >
          Time window
          {sortState.column === "timeWindow"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "fulfillment"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("fulfillment")}
        >
          Fulfillment
          {sortState.column === "fulfillment"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
        <s-button
          icon={
            sortState.column === "city"
              ? sortState.direction === "asc"
                ? "sort-ascending"
                : "sort-descending"
              : "sort"
          }
          onClick={() => handleSort("city")}
        >
          City
          {sortState.column === "city"
            ? sortState.direction === "asc"
              ? " ↑"
              : " ↓"
            : ""}
        </s-button>
      </s-menu>

      {/* Columns config modal */}
      <s-modal
        id="modal-columns"
        heading="Configure Table Columns"
        size="large"
      >
        <s-box padding="base">
          <s-stack direction="inline" gap="large">
            <s-stack direction="block" gap="small">
              <s-text type="strong">General</s-text>
              <s-checkbox
                label="Order name"
                checked={visibleColumns.has("name")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "name",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Customer</s-text>
              <s-checkbox
                label="Customer"
                checked={visibleColumns.has("customer")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "customer",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="City"
                checked={visibleColumns.has("city")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "city",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Status</s-text>
              <s-checkbox
                label="Payment status"
                checked={visibleColumns.has("payment")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "payment",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Fulfillment status"
                checked={visibleColumns.has("fulfillment")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "fulfillment",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
            <s-stack direction="block" gap="small">
              <s-text type="strong">Details</s-text>
              <s-checkbox
                label="Items"
                checked={visibleColumns.has("items")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "items",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Delivery date"
                checked={visibleColumns.has("deliveryDate")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "deliveryDate",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Time window"
                checked={visibleColumns.has("timeWindow")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "timeWindow",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Total"
                checked={visibleColumns.has("total")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "total",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <s-checkbox
                label="Tags / Attributes"
                checked={visibleColumns.has("tags")}
                onChange={(e: Event) =>
                  handleToggleColumn(
                    "tags",
                    (e.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
            </s-stack>
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          commandFor="modal-columns"
          command="--hide"
        >
          Done
        </s-button>
      </s-modal>

      {/* Bulk actions menu */}
      <s-menu id="bulk-actions-menu" accessibilityLabel="Bulk actions">
        <s-button onClick={handleArchive} disabled={isSubmitting}>
          Archive orders
        </s-button>
        <s-button onClick={handleUnarchive} disabled={isSubmitting}>
          Unarchive orders
        </s-button>
        <s-button
          commandFor="modal-add-tags"
          command="--show"
          disabled={isSubmitting}
        >
          Add tags…
        </s-button>
        <s-button
          commandFor="modal-remove-tags"
          command="--show"
          disabled={isSubmitting}
        >
          Remove tags…
        </s-button>
        <s-button
          commandFor="modal-mark-fulfilled"
          command="--show"
          disabled={isSubmitting}
        >
          Mark as fulfilled…
        </s-button>
        <s-button
          commandFor="modal-cancel-orders"
          command="--show"
          tone="critical"
          disabled={isSubmitting}
        >
          Cancel orders…
        </s-button>
      </s-menu>

      {/* Cancel orders confirmation modal */}
      <s-modal
        id="modal-cancel-orders"
        heading="Cancel selected orders?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="critical">
              <s-paragraph>
                {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
                be cancelled. Cancellation is irreversible.
              </s-paragraph>
            </s-banner>
            <s-select
              id="cancel-reason"
              label="Cancellation reason"
              value={cancelReason}
              onChange={(e: Event) => setCancelReason(getSafeEventValue(e))}
            >
              <s-option value="CUSTOMER">Customer request</s-option>
              <s-option value="INVENTORY">Insufficient inventory</s-option>
              <s-option value="DECLINED">Payment declined</s-option>
              <s-option value="FRAUD">Fraud</s-option>
              <s-option value="STAFF">Staff error</s-option>
              <s-option value="OTHER">Other</s-option>
            </s-select>
            <s-checkbox
              label="Restock inventory committed to these orders"
              checked={cancelRestock}
              onChange={(e: Event) =>
                setCancelRestock((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <s-checkbox
              label="Notify customers by email"
              checked={cancelNotify}
              onChange={(e: Event) =>
                setCancelNotify((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <s-text-field
              id="cancel-staff-note"
              label="Staff note (optional, internal only — max 255 chars)"
              value={cancelStaffNote}
              onInput={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
              onChange={(e: Event) => setCancelStaffNote(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-cancel-orders"
          command="--hide"
          disabled={isSubmitting}
        >
          Keep them
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleCancelConfirm}
        >
          {isSubmitting
            ? "Cancelling…"
            : `Cancel ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
        </s-button>
      </s-modal>

      {/* Archive orders confirmation modal */}
      <s-modal
        id="modal-archive-orders"
        heading="Archive selected orders?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>
                {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
                be archived and hidden from the main orders view. You can
                unarchive them later.
              </s-paragraph>
            </s-banner>
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-archive-orders"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleArchiveConfirm}
        >
          {isSubmitting
            ? "Archiving…"
            : `Archive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
        </s-button>
      </s-modal>

      {/* Unarchive orders confirmation modal */}
      <s-modal
        id="modal-unarchive-orders"
        heading="Unarchive selected orders?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="info">
              <s-paragraph>
                {selectedCount} {selectedCount === 1 ? "order" : "orders"} will
                be unarchived and returned to the main orders view.
              </s-paragraph>
            </s-banner>
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-unarchive-orders"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleUnarchiveConfirm}
        >
          {isSubmitting
            ? "Unarchiving…"
            : `Unarchive ${selectedCount} ${selectedCount === 1 ? "order" : "orders"}`}
        </s-button>
      </s-modal>

      {/* Mark as fulfilled modal */}
      <s-modal
        id="modal-mark-fulfilled"
        heading="Mark selected orders as fulfilled?"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-banner tone="warning">
              <s-paragraph>
                This creates a real Shopify fulfillment for {selectedCount}{" "}
                {selectedCount === 1 ? "order" : "orders"}. Customers will
                receive a notification email if &quot;Notify customer&quot; is
                enabled.
              </s-paragraph>
            </s-banner>
            <s-text-field
              id="fulfill-tracking-number"
              label="Tracking number (optional)"
              placeholder="e.g. 1Z999AA10123456784"
              value={fulfillTrackingNumber}
              onInput={(e: Event) =>
                setFulfillTrackingNumber(getSafeEventValue(e))
              }
              onChange={(e: Event) =>
                setFulfillTrackingNumber(getSafeEventValue(e))
              }
            />
            <s-text-field
              id="fulfill-tracking-url"
              label="Tracking URL (optional)"
              placeholder="https://tracking.example.com/…"
              value={fulfillTrackingUrl}
              onInput={(e: Event) =>
                setFulfillTrackingUrl(getSafeEventValue(e))
              }
              onChange={(e: Event) =>
                setFulfillTrackingUrl(getSafeEventValue(e))
              }
            />
            <s-checkbox
              label="Notify customer by email"
              checked={fulfillNotify}
              onChange={(e: Event) =>
                setFulfillNotify((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label
                htmlFor="fulfill-photo-input"
                style={{ fontSize: 13, fontWeight: 500, color: "#202223" }}
              >
                Bouquet Photo (optional)
              </label>
              <input
                id="fulfill-photo-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ fontSize: 13 }}
                onChange={handlePhotoChange}
              />
              {fulfillPhotoError && (
                <p style={{ margin: 0, fontSize: 13, color: "#d72c0d" }}>
                  {fulfillPhotoError}
                </p>
              )}
              {fulfillPhotoPreview && (
                <img
                  src={fulfillPhotoPreview}
                  alt="Bouquet preview"
                  style={{
                    marginTop: 4,
                    maxWidth: 120,
                    maxHeight: 120,
                    objectFit: "cover",
                    borderRadius: 6,
                    border: "1px solid #e1e3e5",
                  }}
                />
              )}
            </div>
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-mark-fulfilled"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || selectedCount === 0}
          onClick={handleMarkFulfilled}
        >
          {isSubmitting
            ? "Fulfilling…"
            : `Mark ${selectedCount} ${selectedCount === 1 ? "order" : "orders"} fulfilled`}
        </s-button>
      </s-modal>

      {/* Add tags modal */}
      <s-modal
        id="modal-add-tags"
        heading="Add tags to selected orders"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-text>
              Add the tags below to {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}.
            </s-text>
            <s-text-field
              id="add-tags-input"
              label="Tags (comma-separated)"
              placeholder="e.g. priority, vip, holiday"
              value={addTagsInput}
              onInput={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
              onChange={(e: Event) => setAddTagsInput(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-add-tags"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isSubmitting || !addTagsInput.trim() || selectedCount === 0}
          onClick={handleAddTags}
        >
          {isSubmitting ? "Adding…" : "Add tags"}
        </s-button>
      </s-modal>

      {/* Remove tags modal */}
      <s-modal
        id="modal-remove-tags"
        heading="Remove tags from selected orders"
        size="small"
      >
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-text>
              Remove the tags below from {selectedCount}{" "}
              {selectedCount === 1 ? "order" : "orders"}.
            </s-text>
            <s-text-field
              id="remove-tags-input"
              label="Tags (comma-separated)"
              placeholder="e.g. priority, vip"
              value={removeTagsInput}
              onInput={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
              onChange={(e: Event) => setRemoveTagsInput(getSafeEventValue(e))}
            />
          </s-stack>
        </s-box>
        <s-button
          slot="secondary-actions"
          commandFor="modal-remove-tags"
          command="--hide"
          disabled={isSubmitting}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={
            isSubmitting || !removeTagsInput.trim() || selectedCount === 0
          }
          onClick={handleRemoveTags}
        >
          {isSubmitting ? "Removing…" : "Remove tags"}
        </s-button>
      </s-modal>

      {/* Items to prep modal (triggered by KPI card button) */}
      <s-modal id="modal-kpi-products" heading="Items to prepare" size="small">
        <s-box padding="base">
          <s-stack direction="block" gap="small">
            {kpiProducts.length === 0 ? (
              <s-text color="subdued">No products found.</s-text>
            ) : (
              <s-stack direction="block" gap="small-100">
                {kpiProducts.map(([name, qty], idx) => (
                  <s-stack
                    key={idx}
                    direction="inline"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-text>{name}</s-text>
                    <s-text type="strong">× {qty}</s-text>
                  </s-stack>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          commandFor="modal-kpi-products"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      {/* Shared row-level tags/attributes modal — one instance for all rows */}
      <s-modal id="modal-tags-shared" heading="Attributes" size="small">
        <s-box padding="base">
          <s-stack direction="inline" gap="small">
            {tagsModalOrderId &&
              getMeaningfulTags(
                (orders.find((o) => o.id === tagsModalOrderId)?.tags) || [],
              ).map((tag) => (
                <s-chip key={tag}>{tagDisplayLabel(tag)}</s-chip>
              ))}
          </s-stack>
        </s-box>
        <s-button
          slot="primary-action"
          commandFor="modal-tags-shared"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      {/* ── Error banner ────────────────────────────────────────────────────── */}
      {error && !errorDismissed && (
        <s-banner
          id="error-banner"
          tone="critical"
          heading="Failed to load orders"
          dismissible
          onDismiss={() => setErrorDismissed(true)}
        >
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {/* ── Header actions bar ───────────────────────────────────────────────── */}
      <div className="ods-header-bar">
        <p className="ods-subtitle">
          Plan, prep, and dispatch deliveries for {subtitleDate}.
        </p>
        <div className="ods-header-btns">
          <s-button
            variant="secondary"
            icon="print"
            onClick={() => window.print()}
          >
            Print picklist
          </s-button>
          {selectedCount === 0 && (
            <s-button
              variant="secondary"
              icon="export"
              onClick={exportForLalamove}
            >
              Export
            </s-button>
          )}
          <s-button variant="primary" href="shopify://admin/orders/new">
            Create order
          </s-button>
        </div>
      </div>

      {/* ── KPI grid ─────────────────────────────────────────────────────────── */}
      <div className="ods-kpi-grid">
        <div className="ods-kpi-card">
          <p className="ods-kpi-label">Orders</p>
          <s-button
            variant="tertiary"
            commandFor="modal-kpi-products"
            command="--show"
            aria-live="polite"
          >
            <span className="ods-kpi-value ods-kpi-value--link">
              {kpiOrderCount}
            </span>
          </s-button>
          {tabCounts.today > 0 && (
            <p className="ods-kpi-sublabel">
              • {tabCounts.today} delivering today
            </p>
          )}
        </div>
        <div className="ods-kpi-card">
          <p className="ods-kpi-label">Revenue</p>
          <p className="ods-kpi-value" aria-live="polite">
            {kpiRevenue}
          </p>
          {kpiAvgRevenue && (
            <p className="ods-kpi-sublabel">• {kpiAvgRevenue}</p>
          )}
        </div>
        <div
          className="ods-kpi-card ods-kpi-card--clickable"
          onClick={() => handleTabChange("unpaid")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && handleTabChange("unpaid")
          }
        >
          <p className="ods-kpi-label">Unpaid</p>
          <p
            className={`ods-kpi-value${kpiUnpaidCount > 0 ? " ods-kpi-value--danger" : ""}`}
            aria-live="polite"
          >
            {kpiUnpaidCount}
          </p>
          {kpiUnpaidTotal && (
            <p
              className={`ods-kpi-sublabel${kpiUnpaidCount > 0 ? " ods-kpi-sublabel--danger" : ""}`}
            >
              {kpiUnpaidTotal}
            </p>
          )}
        </div>
        <div
          className="ods-kpi-card ods-kpi-card--clickable"
          onClick={() => handleTabChange("unfulfilled")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            (e.key === "Enter" || e.key === " ") && handleTabChange("unfulfilled")
          }
        >
          <p className="ods-kpi-label">Unfulfilled</p>
          <p
            className={`ods-kpi-value${kpiUnfulfilledCount > 0 ? " ods-kpi-value--danger" : ""}`}
            aria-live="polite"
          >
            {kpiUnfulfilledCount}
          </p>
          {kpiUnfulfilledDueToday > 0 && (
            <p className="ods-kpi-sublabel ods-kpi-sublabel--danger">
              {kpiUnfulfilledDueToday} due today or earlier
            </p>
          )}
        </div>
        <div className="ods-kpi-card">
          <p className="ods-kpi-label">Delivery Fees</p>
          <p className="ods-kpi-value" aria-live="polite">
            {kpiDeliveryFees}
          </p>
        </div>
      </div>

      {/* ── Tabs + Table (single child so s-page adds no gap between them) ──── */}
      <div className="ods-tabs-table">
        <div className="ods-tabs" role="tablist" aria-label="Filter orders">
          {tabDefs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tabParam === tab.id}
              className={`ods-tab${tabParam === tab.id ? " ods-tab--active" : ""}`}
              onClick={() => handleTabChange(tab.id)}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ods-tab-count">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Table section ────────────────────────────────────────────────────── */}
        <s-section id="orders-table-section" padding="none">
          {selectedCount > 0 && (
            <div
              id="selection-bar"
              className="ods-selection-bar"
              aria-busy={isSubmitting}
            >
              <span className="ods-selection-count">
                {selectedCount} selected
              </span>
              <s-button
                variant="secondary"
                icon="menu-horizontal"
                commandFor="bulk-actions-menu"
                disabled={isSubmitting}
                accessibilityLabel="Bulk actions"
              >
                {isSubmitting ? "Working…" : "Bulk actions"}
              </s-button>
              <s-button
                variant="secondary"
                onClick={exportForLalamove}
                disabled={isSubmitting}
              >
                Export for Lalamove
              </s-button>
              <s-button
                variant="tertiary"
                onClick={handleClearSelection}
                disabled={isSubmitting}
              >
                Clear selection
              </s-button>
              {isSubmitting && (
                <span className="ods-selection-status" aria-live="polite">
                  Submitting selected orders...
                </span>
              )}
            </div>
          )}

          <div className="ods-table-frame">
            <s-table
              id="orders-table"
              paginate={true}
              loading={loading}
              hasNextPage={pageInfo?.hasNextPage || false}
              hasPreviousPage={pageInfo?.hasPreviousPage || false}
              onNextPage={handleNextPage}
              onPreviousPage={handlePreviousPage}
            >
              {/* Toolbar — single compact row */}
              <div slot="filters" className="ods-toolbar">
                <div className="ods-toolbar-search">
                  <s-search-field
                    id="search-field"
                    label="Search orders"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search by order, customer, phone, city"
                    value={searchTerm}
                    onInput={handleSearchInput}
                    onChange={handleSearchInput}
                  />
                </div>
                <div className="ods-toolbar-date">
                  <s-date-field
                    id="toolbar-delivery-date-filter"
                    label="Delivery date"
                    labelAccessibilityVisibility="exclusive"
                    value={deliveryDateFilter}
                    onInput={(e: Event) =>
                      handleDateChange(getSafeEventValue(e))
                    }
                    onChange={(e: Event) =>
                      handleDateChange(getSafeEventValue(e))
                    }
                  />
                </div>
                <div className="ods-toolbar-slot">
                  <s-select
                    id="toolbar-time-slot-filter"
                    label="Time slot"
                    labelAccessibilityVisibility="exclusive"
                    value={timeWindowParam}
                    onChange={(e: Event) => {
                      const val = getSafeEventValue(e);
                      const params = new URLSearchParams(searchParams);
                      if (val) {
                        params.set("timeWindow", val);
                      } else {
                        params.delete("timeWindow");
                      }
                      params.delete("after");
                      params.delete("before");
                      setSelectedIds(new Set());
                      navigate(`?${params.toString()}`, { replace: true });
                    }}
                  >
                    <s-option value="">All time slots</s-option>
                    <s-option value="9AM-12PM">9AM–12PM</s-option>
                    <s-option value="12PM-3PM">12PM–3PM</s-option>
                    <s-option value="3PM-6PM">3PM–6PM</s-option>
                    <s-option value="6PM-11PM">6PM–11PM</s-option>
                  </s-select>
                </div>
                <div className="ods-toolbar-actions">
                  <s-button
                    variant={hasActiveViewControls ? "secondary" : "tertiary"}
                    onClick={handleClearFilters}
                    disabled={!hasActiveViewControls}
                  >
                    Reset
                  </s-button>
                  <s-button
                    variant="secondary"
                    icon={sortState.column ? "sort-ascending" : "sort"}
                    commandFor="sort-menu"
                    accessibilityLabel="Sort orders"
                  >
                    {sortLabel}
                  </s-button>
                  <s-button
                    variant="secondary"
                    commandFor="modal-columns"
                    accessibilityLabel="Configure columns"
                  >
                    Columns
                  </s-button>
                </div>
              </div>

              {/* Table header */}
              <s-table-header-row id="orders-header-row">
                <s-table-header id="header-select" listSlot="kicker">
                  <s-checkbox
                    id="checkbox-select-all"
                    accessibilityLabel="Select all orders"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(e: Event) =>
                      handleToggleAll(
                        (e.currentTarget as HTMLInputElement).checked,
                      )
                    }
                  />
                </s-table-header>
                {visibleColumns.has("name") && (
                  <s-table-header id="header-order" listSlot="primary">
                    Order
                  </s-table-header>
                )}
                {visibleColumns.has("items") && (
                  <s-table-header id="header-item" listSlot="labeled">
                    Items
                  </s-table-header>
                )}
                {visibleColumns.has("customer") && (
                  <s-table-header id="header-customer" listSlot="secondary">
                    Customer
                  </s-table-header>
                )}
                {visibleColumns.has("city") && (
                  <SortableHeader
                    id="header-city"
                    column="city"
                    label="City"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("deliveryDate") && (
                  <SortableHeader
                    id="header-delivery-date"
                    column="deliveryDate"
                    label="Delivery date"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("timeWindow") && (
                  <SortableHeader
                    id="header-time-window"
                    column="timeWindow"
                    label="Time window"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("payment") && (
                  <s-table-header id="header-payment" listSlot="labeled">
                    Payment
                  </s-table-header>
                )}
                {visibleColumns.has("fulfillment") && (
                  <SortableHeader
                    id="header-fulfillment"
                    column="fulfillment"
                    label="Fulfillment"
                    sortState={sortState}
                    onSort={handleSort}
                    listSlot="labeled"
                  />
                )}
                {visibleColumns.has("total") && (
                  <s-table-header id="header-total" listSlot="labeled">
                    Total
                  </s-table-header>
                )}
                {visibleColumns.has("tags") && (
                  <s-table-header id="header-tags" listSlot="labeled">
                    Tags
                  </s-table-header>
                )}
              </s-table-header-row>

              {/* Table body */}
              <s-table-body id="orders-table-body">
                {!loading && displayedOrders.length === 0 ? (
                  <s-table-row id="empty-row">
                    <s-table-cell id="empty-cell">
                      <s-stack gap="base" alignItems="center">
                        <s-icon type="order" />
                        <s-stack gap="small" alignItems="center">
                          <s-text type="strong">
                            {hasActiveFilters
                              ? "No orders match this view"
                              : "No orders found"}
                          </s-text>
                          <s-text color="subdued">
                            {hasActiveFilters
                              ? "Try adjusting or clearing your filters."
                              : "Orders will appear here after customers place them."}
                          </s-text>
                        </s-stack>
                        {hasActiveFilters && (
                          <s-button variant="secondary" onClick={handleClearFilters}>
                            Clear filters
                          </s-button>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  displayedOrders.map((order) => {
                    const orderId = order.id.split("/").pop() || order.id;
                    const isChecked: boolean = selectedIds.has(order.id);
                    const customerName =
                      getCustomerName(order) === "—"
                        ? "Guest"
                        : getCustomerName(order);
                    const instructionText = getInstructionValue(order);
                    const rawDeliveryDate = getDeliveryDateValue(order);
                    const deliveryDateDisplay =
                      rawDeliveryDate !== "—"
                        ? formatDeliveryDate(rawDeliveryDate)
                        : "—";
                    const timeWindow = getDeliveryTimeValue(order);
                    const isOpenOrder = isOpenFulfillmentStatus(
                      order.displayFulfillmentStatus,
                    );
                    const deliveryRelative =
                      rawDeliveryDate !== "—" && isOpenOrder
                        ? getDeliveryRelativeLabel(
                            rawDeliveryDate,
                            dateRefs.todayISO,
                          )
                        : "";
                    const deliveryOverdue =
                      rawDeliveryDate !== "—" &&
                      isOpenOrder &&
                      isDeliveryOverdue(rawDeliveryDate, dateRefs.todayISO);
                    const paymentNeedsAttention = isUnpaidStatus(
                      order.displayFinancialStatus,
                    );
                    const fulfillmentNeedsAttention = isOpenOrder;
                    const total = order.currentTotalPriceSet
                      ? formatMoney(
                          order.currentTotalPriceSet.shopMoney.amount,
                          order.currentTotalPriceSet.shopMoney.currencyCode,
                        )
                      : "—";

                    return (
                      <s-table-row id={`order-row-${orderId}`} key={order.id}>
                        {/* Checkbox */}
                        <s-table-cell id={`cell-select-${orderId}`}>
                          <s-checkbox
                            id={`checkbox-row-${orderId}`}
                            accessibilityLabel={`Select order ${order.name}`}
                            checked={isChecked}
                            onChange={(e: Event) =>
                              handleToggleRow(
                                order.id,
                                (e.currentTarget as HTMLInputElement).checked,
                              )
                            }
                          />
                        </s-table-cell>

                        {/* Order name — opens drawer */}
                        {visibleColumns.has("name") && (
                          <s-table-cell id={`cell-name-${orderId}`}>
                            <div className="ods-name-cell-wrap">
                            <span className="ods-name-cell">
                              <s-button
                                id={`btn-name-${orderId}`}
                                variant="tertiary"
                                onClick={() => setSelectedOrderId(order.id)}
                                accessibilityLabel={`View order ${order.name} details`}
                              >
                                <s-text type="strong">{order.name}</s-text>
                              </s-button>
                              {instructionText !== "—" && (
                                <span
                                  className="ods-note-icon"
                                  title={instructionText}
                                  aria-label={`Note: ${instructionText}`}
                                  role="img"
                                >
                                  <svg
                                    width="13"
                                    height="13"
                                    viewBox="0 0 14 14"
                                    fill="none"
                                    aria-hidden="true"
                                    xmlns="http://www.w3.org/2000/svg"
                                  >
                                    <rect
                                      x="1"
                                      y="1"
                                      width="12"
                                      height="12"
                                      rx="2"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="4.5"
                                      x2="10.5"
                                      y2="4.5"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="7"
                                      x2="10.5"
                                      y2="7"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                    <line
                                      x1="3.5"
                                      y1="9.5"
                                      x2="7.5"
                                      y2="9.5"
                                      stroke="currentColor"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                </span>
                              )}
                            </span>
                            {order.createdAt && (
                              <span className="ods-name-date">
                                {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            )}
                            </div>
                          </s-table-cell>
                        )}

                        {/* Items — thumbnail + summary */}
                        {visibleColumns.has("items") && (
                          <s-table-cell id={`cell-item-${orderId}`}>
                            {(() => {
                              const items = order.lineItems?.edges || [];
                              const itemCount = items.length;
                              const totalQty = items.reduce(
                                (sum, item) => sum + (item.node.quantity || 0),
                                0,
                              );
                              const hasMore = itemCount >= 10;
                              const displayText =
                                itemCount === 0
                                  ? "—"
                                  : itemCount === 1
                                    ? `×${totalQty}`
                                    : hasMore
                                      ? "10+ items"
                                      : `${itemCount} items`;
                              return (
                                <s-button
                                  variant="tertiary"
                                  id={`btn-item-${orderId}`}
                                  onClick={() => setSelectedOrderId(order.id)}
                                >
                                  <s-stack
                                    direction="inline"
                                    gap="small"
                                    alignItems="center"
                                  >
                                    <s-thumbnail
                                      id={`thumbnail-item-${orderId}`}
                                      src={getFirstItemImageUrl(order)}
                                      alt={getFirstItemAltText(order)}
                                      size="small-200"
                                    />
                                    <s-text>{displayText}</s-text>
                                  </s-stack>
                                </s-button>
                              );
                            })()}
                          </s-table-cell>
                        )}

                        {/* Customer */}
                        {visibleColumns.has("customer") && (
                          <s-table-cell id={`cell-customer-${orderId}`}>
                            <s-button
                              variant="tertiary"
                              id={`btn-customer-${orderId}`}
                              onClick={() => setSelectedOrderId(order.id)}
                            >
                              <s-stack direction="block" gap="small-100">
                                <s-text type="strong">{customerName}</s-text>
                                {order.customer?.defaultEmailAddress
                                  ?.emailAddress && (
                                  <s-text color="subdued">
                                    {order.customer.defaultEmailAddress.emailAddress}
                                  </s-text>
                                )}
                              </s-stack>
                            </s-button>
                          </s-table-cell>
                        )}

                        {/* City */}
                        {visibleColumns.has("city") && (
                          <s-table-cell id={`cell-city-${orderId}`}>
                            <s-text>{getCity(order)}</s-text>
                          </s-table-cell>
                        )}

                        {/* Delivery date */}
                        {visibleColumns.has("deliveryDate") && (
                          <s-table-cell id={`cell-delivery-${orderId}`}>
                            <s-stack direction="block" gap="small-100">
                              {rawDeliveryDate !== "—" ? (
                                <s-text type="strong">{deliveryDateDisplay}</s-text>
                              ) : (
                                <s-text color="subdued">{deliveryDateDisplay}</s-text>
                              )}
                              {deliveryRelative && (
                                deliveryOverdue ? (
                                  <s-badge tone="critical">{deliveryRelative}</s-badge>
                                ) : (
                                  <s-badge>{deliveryRelative}</s-badge>
                                )
                              )}
                            </s-stack>
                          </s-table-cell>
                        )}

                        {/* Time window */}
                        {visibleColumns.has("timeWindow") && (
                          <s-table-cell id={`cell-time-window-${orderId}`}>
                            {timeWindow === "—" ? (
                              <s-text color="subdued">{timeWindow}</s-text>
                            ) : (
                              <s-text>{timeWindow}</s-text>
                            )}
                          </s-table-cell>
                        )}

                        {/* Payment */}
                        {visibleColumns.has("payment") && (
                          <s-table-cell id={`cell-payment-${orderId}`}>
                            <span
                              className={`ods-status-cell${paymentNeedsAttention ? " ods-status-cell--attention" : ""}`}
                            >
                              <s-badge
                                tone={financialStatusTone(
                                  order.displayFinancialStatus,
                                )}
                              >
                                {formatStatusLabel(
                                  order.displayFinancialStatus,
                                )}
                              </s-badge>
                            </span>
                          </s-table-cell>
                        )}

                        {/* Fulfillment */}
                        {visibleColumns.has("fulfillment") && (
                          <s-table-cell id={`cell-fulfillment-${orderId}`}>
                            <span
                              className={`ods-status-cell${fulfillmentNeedsAttention ? " ods-status-cell--attention" : ""}`}
                            >
                              <s-badge
                                tone={fulfillmentStatusTone(
                                  order.displayFulfillmentStatus,
                                )}
                              >
                                {formatStatusLabel(
                                  order.displayFulfillmentStatus,
                                )}
                              </s-badge>
                            </span>
                          </s-table-cell>
                        )}

                        {/* Total */}
                        {visibleColumns.has("total") && (
                          <s-table-cell id={`cell-total-${orderId}`}>
                            <s-text>{total}</s-text>
                          </s-table-cell>
                        )}

                        {/* Tags */}
                        {visibleColumns.has("tags") && (
                          <s-table-cell id={`cell-tags-${orderId}`}>
                            {(() => {
                              const meaningful = getMeaningfulTags(
                                order.tags || [],
                              );
                              if (meaningful.length === 0) {
                                return <s-text color="subdued">—</s-text>;
                              }
                              const shown = meaningful.slice(0, 2);
                              const extra = meaningful.length - shown.length;
                              return (
                                <s-stack direction="inline" gap="small">
                                  {shown.map((tag) => (
                                    <s-chip key={tag}>{tagDisplayLabel(tag)}</s-chip>
                                  ))}
                                  {extra > 0 && (
                                    <s-button
                                      variant="tertiary"
                                      id={`btn-tags-${orderId}`}
                                      onClick={() => showTagsModal(order.id)}
                                    >
                                      +{extra}
                                    </s-button>
                                  )}
                                </s-stack>
                              );
                            })()}
                          </s-table-cell>
                        )}
                      </s-table-row>
                    );
                  })
                )}
              </s-table-body>
            </s-table>
          </div>
        </s-section>
      </div>
      {/* end ods-tabs-table */}

      {/* ── Right-side order detail drawer ──────────────────────────────────── */}
      {selectedOrder && (
        <OrderDrawer
          order={selectedOrder}
          onClose={handleCloseDrawer}
          onMarkFulfilled={handleDrawerMarkFulfilled}
        />
      )}
    </s-page>
  );
}

export default Extension;
