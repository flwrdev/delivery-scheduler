// COD fee auto-add (orders/create webhook).
//
// The +₱70 COD fee cannot exist at checkout time: Shopify exposes no way to
// change the payable total based on the selected payment method (payment
// selection is the final step; no Function API sees it). The fee therefore
// lands POST-purchase — when a new order paid via the merchant's manual
// "Cash on Delivery" method arrives, this service adds the hidden COD-fee
// variant (matched by SKU) to the order via an order edit. The customer sees
// the fee on the final invoice / order status page; cash collected on
// delivery includes it.
//
// Never throws — the webhook must always return 200 (Meta/Shopify redeliver
// on non-200). Redelivery-safe: an order already carrying the fee SKU is
// skipped — the line-item scan pages through the whole connection, and a scan
// that fails or hits its bound adds nothing rather than assuming "absent".
// The variant is matched by EXACT SKU (`sku:` search tokenizes on hyphens, so
// it also returns COD-FEE-OLD and friends).

import type { AdminGraphQLClient } from "./order-delivery-metafields.server";

export const COD_FEE_SKU = "COD-FEE";

const COD_GATEWAY_EXACT = new Set(["cod"]);

export interface ApplyCodFeeResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  errors: string[];
}

interface OrderLineItemSkusResponse {
  data?: {
    order?: {
      lineItems?: {
        nodes?: Array<{ sku?: string | null }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface FeeVariantLookupResponse {
  data?: {
    productVariants?: {
      nodes?: Array<{
        id?: string | null;
        sku?: string | null;
        price?: string | null;
        product?: { id?: string | null } | null;
      }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

// The COD Fee variant, as both the webhook and the COD Settings page need it.
export interface CodFeeVariant {
  id: string;
  sku: string;
  price: string;
  productId: string;
}

export interface FindCodFeeVariantResult {
  variant: CodFeeVariant | null;
  errors: string[];
}

// Fee-SKU presence on an order: "unknown" (lookup failed or the scan was
// truncated) is deliberately NOT "absent" — only "absent" may add the fee.
type FeeSkuScan =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; errors: string[] };

interface OrderEditBeginResponse {
  data?: {
    orderEditBegin?: {
      calculatedOrder?: { id?: string | null } | null;
      userErrors?: Array<{ field?: string[]; message: string }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface OrderEditAddVariantResponse {
  data?: {
    orderEditAddVariant?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface OrderEditCommitResponse {
  data?: {
    orderEditCommit?: {
      order?: { id?: string | null } | null;
      userErrors?: Array<{ field?: string[]; message: string }>;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

// Line-item page size + the bound on how many pages the redelivery guard
// reads. 10 × 100 = 1,000 line items; past that the scan reports "unknown"
// rather than pretending the fee is absent (a double charge is worse than a
// missing fee).
const LINE_ITEM_PAGE_SIZE = 100;
const MAX_LINE_ITEM_PAGES = 10;

// Candidates fetched per SKU lookup. Shopify's search tokenizes on hyphens,
// so `sku:COD-FEE` also returns COD-FEE-OLD / COD-FEE-2024 / FEE-COD — we ask
// for a page of them and keep only the exact-SKU match.
const FEE_VARIANT_CANDIDATES = 50;

const ORDER_LINE_ITEM_SKUS_QUERY = `#graphql
  query CodFeeOrderLineItemSkus($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        nodes {
          sku
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const FEE_VARIANT_LOOKUP_QUERY = `#graphql
  query CodFeeVariantLookup($query: String!, $first: Int!) {
    productVariants(first: $first, query: $query) {
      nodes {
        id
        sku
        price
        product {
          id
        }
      }
    }
  }
`;

const ORDER_EDIT_BEGIN_MUTATION = `#graphql
  mutation CodFeeOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_ADD_VARIANT_MUTATION = `#graphql
  mutation CodFeeOrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_COMMIT_MUTATION = `#graphql
  mutation CodFeeOrderEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Manual payment methods surface in the webhook payload's
// payment_gateway_names under the merchant-configured method name.
export function isCashOnDeliveryOrder(
  payload: Record<string, unknown>,
): boolean {
  const rawNames = payload.payment_gateway_names;
  if (!Array.isArray(rawNames)) {
    return false;
  }

  return rawNames.some((name) => {
    if (typeof name !== "string") {
      return false;
    }
    const normalized = name.toLowerCase().trim();
    return (
      normalized.includes("cash on delivery") ||
      COD_GATEWAY_EXACT.has(normalized)
    );
  });
}

function collectErrors(
  label: string,
  result: {
    errors?: Array<{ message: string }>;
  },
  userErrors?: Array<{ message: string }>,
): string[] {
  const graphQLErrors = result.errors?.map((e) => `${label}: ${e.message}`) ?? [];
  const mutationErrors = userErrors?.map((e) => `${label}: ${e.message}`) ?? [];
  return [...graphQLErrors, ...mutationErrors];
}

// The ONE fee-variant lookup — used by the webhook (which charges it) and by
// the COD Settings page (which prices it), so the merchant can never edit a
// different variant than the one the webhook adds. `sku:` search is fuzzy;
// only an EXACT sku match (the same comparison the redelivery guard uses)
// counts. No exact match ⇒ null, never "whatever came back first". Never
// throws — callers decide, and the webhook must still return 200.
export async function findCodFeeVariant(
  admin: AdminGraphQLClient,
  feeSku: string = COD_FEE_SKU,
): Promise<FindCodFeeVariantResult> {
  try {
    const response = await admin.graphql(FEE_VARIANT_LOOKUP_QUERY, {
      variables: { query: `sku:${feeSku}`, first: FEE_VARIANT_CANDIDATES },
    });
    const result = (await response.json()) as FeeVariantLookupResponse;
    const errors = collectErrors("variant lookup", result);
    if (errors.length > 0) {
      return { variant: null, errors };
    }

    const nodes = result.data?.productVariants?.nodes ?? [];
    const exact = nodes.find((node) => node.sku === feeSku);
    if (!exact?.id) {
      return { variant: null, errors: [] };
    }

    return {
      variant: {
        id: exact.id,
        sku: feeSku,
        price: exact.price ?? "",
        productId: exact.product?.id ?? "",
      },
      errors: [],
    };
  } catch (error) {
    return {
      variant: null,
      errors: [
        `variant lookup: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

// Redelivery guard. The fee line added by a first delivery can sit past the
// first 100-node page on a big order, so page through the connection instead
// of trusting page 1. Bounded at MAX_LINE_ITEM_PAGES; hitting the bound is
// logged and reported as "unknown", never as "absent".
async function scanOrderForFeeSku(
  admin: AdminGraphQLClient,
  orderId: string,
  feeSku: string,
): Promise<FeeSkuScan> {
  let after: string | null = null;

  for (let page = 0; page < MAX_LINE_ITEM_PAGES; page += 1) {
    const response = await admin.graphql(ORDER_LINE_ITEM_SKUS_QUERY, {
      variables: { id: orderId, first: LINE_ITEM_PAGE_SIZE, after },
    });
    const result = (await response.json()) as OrderLineItemSkusResponse;
    const errors = collectErrors("order lookup", result);
    if (errors.length > 0) {
      return { status: "unknown", errors };
    }

    const lineItems = result.data?.order?.lineItems;
    const skus = lineItems?.nodes?.map((n) => n.sku) ?? [];
    if (skus.includes(feeSku)) {
      return { status: "present" };
    }
    if (!lineItems?.pageInfo?.hasNextPage) {
      return { status: "absent" };
    }

    after = lineItems.pageInfo.endCursor ?? null;
    if (!after) {
      console.warn(
        `[cod-fee] order ${orderId}: hasNextPage without an endCursor; fee SKU presence unknown.`,
      );
      return {
        status: "unknown",
        errors: ["order lookup: line item paging returned no cursor"],
      };
    }
  }

  const scanned = MAX_LINE_ITEM_PAGES * LINE_ITEM_PAGE_SIZE;
  console.warn(
    `[cod-fee] order ${orderId}: line item scan truncated after ${scanned} items; fee SKU presence unknown.`,
  );
  return {
    status: "unknown",
    errors: [
      `order lookup: line item scan truncated after ${scanned} items; cannot confirm sku:${feeSku} is absent`,
    ],
  };
}

export async function applyCodFeeToOrder(
  admin: AdminGraphQLClient,
  options: { orderId: string; feeSku?: string },
): Promise<ApplyCodFeeResult> {
  const feeSku = options.feeSku ?? COD_FEE_SKU;

  try {
    const scan = await scanOrderForFeeSku(admin, options.orderId, feeSku);
    if (scan.status === "unknown") {
      return { ok: false, skipped: false, errors: scan.errors };
    }
    if (scan.status === "present") {
      return {
        ok: true,
        skipped: true,
        reason: "fee already on order",
        errors: [],
      };
    }

    const { variant, errors: variantErrors } = await findCodFeeVariant(
      admin,
      feeSku,
    );
    if (variantErrors.length > 0) {
      return { ok: false, skipped: false, errors: variantErrors };
    }
    if (!variant) {
      return {
        ok: false,
        skipped: false,
        errors: [`variant lookup: no product variant with sku:${feeSku}`],
      };
    }

    const variantId = variant.id;

    const beginResponse = await admin.graphql(ORDER_EDIT_BEGIN_MUTATION, {
      variables: { id: options.orderId },
    });
    const beginResult = (await beginResponse.json()) as OrderEditBeginResponse;
    const beginErrors = collectErrors(
      "orderEditBegin",
      beginResult,
      beginResult.data?.orderEditBegin?.userErrors,
    );
    if (beginErrors.length > 0) {
      return { ok: false, skipped: false, errors: beginErrors };
    }

    const calculatedOrderId =
      beginResult.data?.orderEditBegin?.calculatedOrder?.id;
    if (!calculatedOrderId) {
      return {
        ok: false,
        skipped: false,
        errors: ["orderEditBegin: no calculatedOrder id returned"],
      };
    }

    const addResponse = await admin.graphql(ORDER_EDIT_ADD_VARIANT_MUTATION, {
      variables: { id: calculatedOrderId, variantId, quantity: 1 },
    });
    const addResult =
      (await addResponse.json()) as OrderEditAddVariantResponse;
    const addErrors = collectErrors(
      "orderEditAddVariant",
      addResult,
      addResult.data?.orderEditAddVariant?.userErrors,
    );
    if (addErrors.length > 0) {
      return { ok: false, skipped: false, errors: addErrors };
    }

    const commitResponse = await admin.graphql(ORDER_EDIT_COMMIT_MUTATION, {
      variables: {
        id: calculatedOrderId,
        staffNote: "COD fee auto-added (orders/create webhook)",
      },
    });
    const commitResult =
      (await commitResponse.json()) as OrderEditCommitResponse;
    const commitErrors = collectErrors(
      "orderEditCommit",
      commitResult,
      commitResult.data?.orderEditCommit?.userErrors,
    );
    if (commitErrors.length > 0) {
      return { ok: false, skipped: false, errors: commitErrors };
    }

    return { ok: true, skipped: false, errors: [] };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      errors: [
        `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
