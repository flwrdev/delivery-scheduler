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
// skipped.

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
      lineItems?: { nodes?: Array<{ sku?: string | null }> } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface FeeVariantLookupResponse {
  data?: {
    productVariants?: { nodes?: Array<{ id?: string | null }> } | null;
  };
  errors?: Array<{ message: string }>;
}

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

const ORDER_LINE_ITEM_SKUS_QUERY = `#graphql
  query CodFeeOrderLineItemSkus($id: ID!) {
    order(id: $id) {
      lineItems(first: 100) {
        nodes {
          sku
        }
      }
    }
  }
`;

const FEE_VARIANT_LOOKUP_QUERY = `#graphql
  query CodFeeVariantLookup($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes {
        id
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

export async function applyCodFeeToOrder(
  admin: AdminGraphQLClient,
  options: { orderId: string; feeSku?: string },
): Promise<ApplyCodFeeResult> {
  const feeSku = options.feeSku ?? COD_FEE_SKU;

  try {
    const lineItemsResponse = await admin.graphql(ORDER_LINE_ITEM_SKUS_QUERY, {
      variables: { id: options.orderId },
    });
    const lineItemsResult =
      (await lineItemsResponse.json()) as OrderLineItemSkusResponse;
    const lineItemErrors = collectErrors("order lookup", lineItemsResult);
    if (lineItemErrors.length > 0) {
      return { ok: false, skipped: false, errors: lineItemErrors };
    }

    const skus =
      lineItemsResult.data?.order?.lineItems?.nodes?.map((n) => n.sku) ?? [];
    if (skus.includes(feeSku)) {
      return {
        ok: true,
        skipped: true,
        reason: "fee already on order",
        errors: [],
      };
    }

    const variantResponse = await admin.graphql(FEE_VARIANT_LOOKUP_QUERY, {
      variables: { query: `sku:${feeSku}` },
    });
    const variantResult =
      (await variantResponse.json()) as FeeVariantLookupResponse;
    const variantErrors = collectErrors("variant lookup", variantResult);
    if (variantErrors.length > 0) {
      return { ok: false, skipped: false, errors: variantErrors };
    }

    const variantId = variantResult.data?.productVariants?.nodes?.[0]?.id;
    if (!variantId) {
      return {
        ok: false,
        skipped: false,
        errors: [`variant lookup: no product variant with sku:${feeSku}`],
      };
    }

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
