import type { DeliveryValidationItem } from "../lib/delivery-availability";

export interface AdminGraphQLClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

interface SubmittedCartItem extends DeliveryValidationItem {
  productId?: unknown;
  product_id?: unknown;
  variantSku?: unknown;
}

interface ProductTagsQueryResponse {
  data?: {
    nodes?: Array<{ id?: string | null; tags?: string[] | null } | null>;
  };
  errors?: Array<{ message: string }>;
}

interface OrderLineItemsQueryResponse {
  data?: {
    order?: {
      lineItems?: {
        edges?: Array<{
          node?: {
            sku?: string | null;
            variant?: {
              sku?: string | null;
              product?: { tags?: string[] | null } | null;
            } | null;
          } | null;
        }>;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

const PRODUCT_TAGS_QUERY = `#graphql
  query MothersDayProductTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        tags
      }
    }
  }
`;

const ORDER_MOTHERS_DAY_LINE_ITEMS_QUERY = `#graphql
  query OrderMothersDayLineItems($id: ID!) {
    order(id: $id) {
      lineItems(first: 250) {
        edges {
          node {
            sku
            variant {
              sku
              product {
                tags
              }
            }
          }
        }
      }
    }
  }
`;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProductGid(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `gid://shopify/Product/${value}`;
  }

  const rawValue = stringValue(value);
  if (!rawValue) return null;
  if (rawValue.startsWith("gid://shopify/Product/")) return rawValue;
  if (/^\d+$/.test(rawValue)) return `gid://shopify/Product/${rawValue}`;

  return null;
}

function getSubmittedCartItemSku(item: SubmittedCartItem): string {
  return stringValue(item.sku) || stringValue(item.variantSku);
}

async function loadProductTagsById(
  admin: AdminGraphQLClient,
  productIds: string[],
): Promise<Map<string, string[]>> {
  const uniqueProductIds = [...new Set(productIds)];
  if (!uniqueProductIds.length) {
    return new Map();
  }

  const response = await admin.graphql(PRODUCT_TAGS_QUERY, {
    variables: { ids: uniqueProductIds },
  });
  const result = (await response.json()) as ProductTagsQueryResponse;

  if (!response.ok || result.errors?.length) {
    return new Map();
  }

  const tagsById = new Map<string, string[]>();
  for (const node of result.data?.nodes ?? []) {
    const id = node?.id;
    if (id) {
      tagsById.set(id, node.tags ?? []);
    }
  }

  return tagsById;
}

export async function hydrateSubmittedCartMothersDayItems(
  admin: AdminGraphQLClient,
  items: unknown,
): Promise<DeliveryValidationItem[]> {
  if (!Array.isArray(items)) {
    return [];
  }

  const submittedItems = items.filter(
    (item): item is SubmittedCartItem => !!item && typeof item === "object",
  );
  const itemProductIds = submittedItems.map((item) =>
    normalizeProductGid(item.productId ?? item.product_id),
  );
  const productTagsById = await loadProductTagsById(
    admin,
    itemProductIds.filter((id): id is string => Boolean(id)),
  );

  return submittedItems.map((item, index) => {
    const productId = itemProductIds[index];
    return {
      sku: getSubmittedCartItemSku(item),
      productTags: productId
        ? (productTagsById.get(productId) ?? item.productTags)
        : item.productTags,
      tags: item.tags,
      mothersDayEligible: item.mothersDayEligible,
    };
  });
}

export async function loadOrderMothersDayValidationItems(
  admin: AdminGraphQLClient,
  orderId: string,
): Promise<DeliveryValidationItem[]> {
  const response = await admin.graphql(ORDER_MOTHERS_DAY_LINE_ITEMS_QUERY, {
    variables: { id: orderId },
  });
  const result = (await response.json()) as OrderLineItemsQueryResponse;

  if (!response.ok || result.errors?.length) {
    return [];
  }

  return (result.data?.order?.lineItems?.edges ?? []).flatMap((edge) => {
    const node = edge.node;
    if (!node) return [];

    return [
      {
        sku: node.sku ?? node.variant?.sku ?? "",
        productTags: node.variant?.product?.tags ?? [],
      },
    ];
  });
}
