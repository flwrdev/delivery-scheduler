import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from "react";

// Lazy-loaded: the drawer only mounts when a merchant opens an order, so it
// ships as a separate chunk off the initial bundle.
const OrderDrawer = lazy(() =>
  import("../components/OrderDrawer").then((m) => ({ default: m.OrderDrawer })),
);
import {
  type Order,
  toLocalISODate,
  normalizeDateToISO,
  formatDeliveryDate,
  formatMoney,
  financialStatusTone,
  isUnpaidStatus,
  fulfillmentStatusTone,
  isOpenFulfillmentStatus,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getCity,
  getInstructionValue,
  getFirstItemImageUrl,
  getFirstItemAltText,
} from "../lib/order-utils";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  useNavigation,
} from "react-router";
import { useBulkActions } from "../hooks/useBulkActions";
import { getSafeEventValue } from "../lib/get-safe-event-value";
import { CancelModal } from "../components/orders/CancelModal";
import { ArchiveModal } from "../components/orders/ArchiveModal";
import { UnarchiveModal } from "../components/orders/UnarchiveModal";
import { authenticate } from "../shopify.server";
import stylesHref from "../styles/orders-dashboard.css?url";

export const links = () => [{ rel: "stylesheet", href: stylesHref }];

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

export type BulkActionName =
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

export interface BulkActionResponse {
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

  // Row selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Right-side drawer state — store only the ID so the drawer always reflects fresh loader data
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

  // Shared tags modal state — single modal instance reused for all rows
  const [tagsModalOrderId, setTagsModalOrderId] = useState<string | null>(null);
  const [tagsModalTrigger, setTagsModalTrigger] = useState(0);

  const handleCloseDrawer = useCallback(() => setSelectedOrderId(null), []);

  const showTagsModal = useCallback((orderId: string) => {
    setTagsModalOrderId(orderId);
    setTagsModalTrigger((n) => n + 1);
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

  // ── Search handler ─────────────────────────────────────────────────────────

  const handleSearchInput = (e: Event): void => {
    setSearchTerm(getSafeEventValue(e));
  };

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

  const displayedOrders: Order[] = filteredOrders;

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


  // ── Bulk actions (archive / unarchive / cancel / tags / fulfill) ───────────
  //    State + submission + toast handling moved verbatim to useBulkActions.

  const {
    isSubmitting,
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
    fulfillTrackingNumber,
    setFulfillTrackingNumber,
    fulfillTrackingUrl,
    setFulfillTrackingUrl,
    fulfillNotify,
    setFulfillNotify,
    fulfillPhotoPreview,
    fulfillPhotoError,
    handlePhotoChange,
    handleArchive,
    handleUnarchive,
    handleArchiveConfirm,
    handleUnarchiveConfirm,
    handleCancelConfirm,
    handleAddTags,
    handleRemoveTags,
    handleMarkFulfilled,
  } = useBulkActions(selectedIds, setSelectedIds);

  // ── Render ─────────────────────────────────────────────────────────────────

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
  const hasActiveViewControls = hasActiveFilters;

  return (
    <s-page
      id="orders-dashboard-page"
      heading="Orders Operations"
      inlineSize="large"
    >
      {/* ── Global modals ──────────────────────────────────────────────────── */}

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
      <CancelModal
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

      {/* Archive orders confirmation modal */}
      <ArchiveModal
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        onConfirm={handleArchiveConfirm}
      />

      {/* Unarchive orders confirmation modal */}
      <UnarchiveModal
        selectedCount={selectedCount}
        isSubmitting={isSubmitting}
        onConfirm={handleUnarchiveConfirm}
      />

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
                <s-table-header id="header-order" listSlot="primary">
                  Order
                </s-table-header>
                <s-table-header id="header-item" listSlot="labeled">
                  Items
                </s-table-header>
                <s-table-header id="header-customer" listSlot="secondary">
                  Customer
                </s-table-header>
                <s-table-header id="header-city" listSlot="labeled">City</s-table-header>
                <s-table-header id="header-delivery-date" listSlot="labeled">Delivery date</s-table-header>
                <s-table-header id="header-time-window" listSlot="labeled">Time window</s-table-header>
                <s-table-header id="header-payment" listSlot="labeled">
                  Payment
                </s-table-header>
                <s-table-header id="header-fulfillment" listSlot="labeled">Fulfillment</s-table-header>
                <s-table-header id="header-total" listSlot="labeled">
                  Total
                </s-table-header>
                <s-table-header id="header-tags" listSlot="labeled">
                  Tags
                </s-table-header>
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

                        {/* Items — thumbnail + summary */}
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

                        {/* Customer */}
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

                        {/* City */}
                        <s-table-cell id={`cell-city-${orderId}`}>
                          <s-text>{getCity(order)}</s-text>
                        </s-table-cell>

                        {/* Delivery date */}
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

                        {/* Time window */}
                        <s-table-cell id={`cell-time-window-${orderId}`}>
                          {timeWindow === "—" ? (
                            <s-text color="subdued">{timeWindow}</s-text>
                          ) : (
                            <s-text>{timeWindow}</s-text>
                          )}
                        </s-table-cell>

                        {/* Payment */}
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

                        {/* Fulfillment */}
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

                        {/* Total */}
                        <s-table-cell id={`cell-total-${orderId}`}>
                          <s-text>{total}</s-text>
                        </s-table-cell>

                        {/* Tags */}
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
        <Suspense fallback={null}>
          <OrderDrawer
            order={selectedOrder}
            onClose={handleCloseDrawer}
          />
        </Suspense>
      )}
    </s-page>
  );
}

export default Extension;
