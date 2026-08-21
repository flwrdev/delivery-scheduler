// Order-status lookup by ORDER NUMBER + ZIP CODE (2026-08-21) — READ-ONLY.
//
// Replaces email-only verification (lookupOrdersByEmail in
// messenger-orders.server.ts, kept around for now so nothing else breaks) for
// the Messenger agent's lookup_order tool. Merchant decision: both the order
// number and the checkout zip are on the order confirmation email, so this is
// no harder for the customer while being a real two-factor check instead of
// email alone.
//
// SECURITY: the zip is NEVER put into the Shopify search query — only the
// order name is searched for, then the zip is compared IN CODE against the
// order's shippingAddress.zip. Wrong order number and wrong zip return the
// EXACT SAME generic failure string, so a guesser (trying zips against a
// known order number, or vice versa) learns nothing about which half they
// got right. The CALLER still needs to tell a real wrong guess apart from an
// infrastructure failure (else a Shopify outage locks out a blameless
// customer), so every failure also carries a machine-readable `reason` —
// see LookupFailureReason below. The `error` string stays identical.
//
// Also exports lookupOrdersByCustomerId for surfaces that already have a
// verified Shopify customer session (customer account, logged-in storefront)
// and therefore need NO additional verification.
//
// Redaction rule (same as lookupOrdersByEmail): share ONLY status + delivery
// schedule + tracking — never address, phone, or payment details.
//
// Log hygiene: order names, counts, error strings — never zip/address/phone.

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

// Frozen attribute keys — same contract the checkout writes and the
// orders/create sync reads (see messenger-orders.server.ts).
const DELIVERY_DATE_ATTRIBUTE_KEY = "Delivery Date";
const DELIVERY_TIME_ATTRIBUTE_KEY = "Delivery Time";

const GENERIC_LOOKUP_FAILURE =
  "We could not find an order matching that order number and zip code. Please double-check both — they are both on your order confirmation email.";

const LOOKUP_FAILURE_THRESHOLD = 5;
const LOOKUP_LOCKOUT_MINUTES = 30;

export interface MessengerOrderTracking {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  deliveryDate: string;
  deliveryTime: string;
  trackingUrl?: string;
  trackingNumber?: string;
  trackingCompany?: string;
}

/**
 * WHY a machine-readable failure discriminant (MAJOR fix): the customer-facing
 * `error` string is DELIBERATELY the same for a wrong order number and a wrong
 * zip (anti-enumeration — see the header), so the caller cannot tell a real
 * wrong guess apart from a Shopify outage / unset MESSENGER_SHOP / Neon blip by
 * reading the string. Without this, an infrastructure failure burned a lockout
 * attempt and could lock a completely blameless customer out of order support
 * for 30 minutes. Only `mismatch` is a real guess:
 *   - "mismatch"      the order genuinely does not match (wrong number OR wrong
 *                     zip — indistinguishable ON PURPOSE, same `error` string)
 *   - "ambiguous"     the search page came back FULL with no exact match, so a
 *                     real match could sit just past the page boundary — an
 *                     inconclusive search, not proof of a wrong guess
 *   - "invalid_input" a field was missing — a prompting issue, not a guess
 *   - "upstream"      Shopify/admin-client/network failure — never the
 *                     customer's fault
 */
export type LookupFailureReason = "mismatch" | "ambiguous" | "invalid_input" | "upstream";

export type LookupOrderResult =
  | { ok: true; order: MessengerOrderTracking; note: string }
  // `ambiguous: true` is kept as the legacy boolean alias of
  // reason === "ambiguous" so older callers/tests keep reading the same flag.
  | { ok: false; error: string; reason: LookupFailureReason; ambiguous?: boolean };

export type LookupOrdersByCustomerIdResult =
  | { ok: true; orders: MessengerOrderTracking[]; note: string }
  | { ok: false; error: string; reason: LookupFailureReason };

interface AdminGraphqlClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

async function getAdminClient(): Promise<
  { ok: true; admin: AdminGraphqlClient } | { ok: false; error: string }
> {
  const shop = process.env.MESSENGER_SHOP?.trim();
  if (!shop) {
    return { ok: false, error: "MESSENGER_SHOP is not configured on this environment." };
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { ok: true, admin: admin as unknown as AdminGraphqlClient };
  } catch (error) {
    return {
      ok: false,
      error: `Shopify admin client unavailable: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }
}

interface OrderLookupNode {
  name?: string;
  createdAt?: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  shippingAddress?: { zip?: string | null } | null;
  customAttributes?: Array<{ key?: string; value?: string | null }> | null;
  fulfillments?: Array<{
    trackingInfo?: Array<{ number?: string | null; url?: string | null; company?: string | null }> | null;
  }> | null;
}

const ORDER_LOOKUP_NODE_FIELDS = `
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  shippingAddress {
    zip
  }
  customAttributes {
    key
    value
  }
  fulfillments(first: 3) {
    trackingInfo {
      number
      url
      company
    }
  }
`;

// Shopify's `name:` search is loose (a short order number can be a prefix
// match candidate for longer ones, e.g. #100 vs #1000..#1004), so this page
// needs to be big enough to reliably contain the exact match — this is a
// rare, per-customer call, so 25 is cheap. sortKey: RELEVANCE puts the
// closest matches first within that page.
const ORDER_LOOKUP_PAGE_SIZE = 25;

const ORDER_LOOKUP_QUERY = `#graphql
  query OrderLookup($query: String!) {
    orders(first: ${ORDER_LOOKUP_PAGE_SIZE}, query: $query, sortKey: RELEVANCE) {
      nodes {
        ${ORDER_LOOKUP_NODE_FIELDS}
      }
    }
  }
`;

const ORDERS_BY_CUSTOMER_ID_QUERY = `#graphql
  query OrdersByCustomerId($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ${ORDER_LOOKUP_NODE_FIELDS}
      }
    }
  }
`;

// Strip quotes/backslashes so search values cannot break out of Shopify's
// search-query syntax (same idiom as lookupOrdersByEmail).
function sanitizeSearchValue(value: string): string {
  return value.replace(/["\\]/g, "");
}

export function normalizeOrderName(raw: string): string {
  return raw.trim().replace(/^#/, "").trim();
}

export function normalizeZip(raw: string): string {
  return raw.replace(/\D/g, "");
}

function attr(
  attrs: Array<{ key?: string; value?: string | null }> | null | undefined,
  key: string,
): string {
  return attrs?.find((a) => a.key === key)?.value ?? "";
}

function toOrderTracking(node: OrderLookupNode): MessengerOrderTracking {
  const trackingInfo = node.fulfillments?.find((f) => (f.trackingInfo?.length ?? 0) > 0)
    ?.trackingInfo?.[0];
  return {
    name: node.name ?? "",
    createdAt: node.createdAt ?? "",
    financialStatus: node.displayFinancialStatus ?? "",
    fulfillmentStatus: node.displayFulfillmentStatus ?? "",
    deliveryDate: attr(node.customAttributes, DELIVERY_DATE_ATTRIBUTE_KEY),
    deliveryTime: attr(node.customAttributes, DELIVERY_TIME_ATTRIBUTE_KEY),
    ...(trackingInfo?.url ? { trackingUrl: trackingInfo.url } : {}),
    ...(trackingInfo?.number ? { trackingNumber: trackingInfo.number } : {}),
    ...(trackingInfo?.company ? { trackingCompany: trackingInfo.company } : {}),
  };
}

/**
 * Look up ONE order by order name + the zip used at checkout. Both must
 * match; the zip comparison happens IN CODE, never in the GraphQL query, and
 * every failure path (bad order#, bad zip, no shippingAddress on file)
 * returns the identical generic error string.
 */
export async function lookupOrderByNameAndZip(input: {
  orderName: string;
  zip: string;
}): Promise<LookupOrderResult> {
  const orderName = normalizeOrderName(input.orderName ?? "");
  const zip = normalizeZip(input.zip ?? "");

  if (!orderName || !zip) {
    return {
      ok: false,
      error: "Please provide both the order number and the zip code.",
      reason: "invalid_input",
    };
  }

  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error, reason: "upstream" };
  }

  try {
    const response = await client.admin.graphql(ORDER_LOOKUP_QUERY, {
      variables: { query: `name:"${sanitizeSearchValue(orderName)}"` },
    });
    const body = (await response.json()) as {
      data?: { orders?: { nodes?: OrderLookupNode[] } };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length) {
      return {
        ok: false,
        error: body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`,
        reason: "upstream",
      };
    }

    const nodes = body.data?.orders?.nodes ?? [];
    // Match by normalized name (GraphQL's `name:` search can be loose/partial
    // in some cases) AND by zip, comparing in code so the zip never leaves
    // this function's process as part of the query string.
    const match = nodes.find((node) => normalizeOrderName(node.name ?? "") === orderName);

    if (match) {
      if (normalizeZip(match.shippingAddress?.zip ?? "") !== zip) {
        // The order exists — the zip is simply wrong. A real mismatch.
        console.log(`[order-lookup] name+zip lookup: zip mismatch order=${orderName}`);
        // Byte-identical `error` to the wrong-order-number path below — the
        // `reason` is for the CALLER's lockout accounting only, never surfaced.
        return { ok: false, error: GENERIC_LOOKUP_FAILURE, reason: "mismatch" };
      }
    } else {
      // No exact name match in the page. If the page came back FULL, this is
      // inconclusive (the real order could be just past the page boundary) —
      // not proof the order number is wrong, so mark it ambiguous rather than
      // a real mismatch (see ORDER_LOOKUP_PAGE_SIZE comment above).
      const ambiguous = nodes.length >= ORDER_LOOKUP_PAGE_SIZE;
      console.log(
        `[order-lookup] name+zip lookup: no match order=${orderName}${ambiguous ? " (ambiguous: page full)" : ""}`,
      );
      return {
        ok: false,
        error: GENERIC_LOOKUP_FAILURE,
        reason: ambiguous ? "ambiguous" : "mismatch",
        ...(ambiguous ? { ambiguous: true } : {}),
      };
    }

    console.log(`[order-lookup] name+zip lookup matched order=${match.name}`);
    return {
      ok: true,
      order: toOrderTracking(match),
      note:
        "Share ONLY the status, delivery schedule, and tracking link/number — never an address, phone number, or payment details.",
    };
  } catch (error) {
    // GraphQL threw / network died — infrastructure, never the customer's
    // guess, kaya it must NOT burn a lockout attempt.
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Order lookup failed.",
      reason: "upstream",
    };
  }
}

/**
 * Look up recent orders for an ALREADY-AUTHENTICATED Shopify customer (e.g.
 * the customer account extension, or a logged-in storefront surface). No
 * additional verification is needed here — the caller's own auth already
 * proved who the customer is.
 */
export async function lookupOrdersByCustomerId(
  customerGid: string,
): Promise<LookupOrdersByCustomerIdResult> {
  const numericId = (customerGid ?? "").trim().match(/(\d+)\s*$/)?.[1];
  if (!numericId) {
    return {
      ok: false,
      error: "That does not look like a valid customer id.",
      reason: "invalid_input",
    };
  }

  const client = await getAdminClient();
  if (!client.ok) {
    return { ok: false, error: client.error, reason: "upstream" };
  }

  try {
    const response = await client.admin.graphql(ORDERS_BY_CUSTOMER_ID_QUERY, {
      variables: { query: `customer_id:${numericId}` },
    });
    const body = (await response.json()) as {
      data?: { orders?: { nodes?: OrderLookupNode[] } };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || body.errors?.length) {
      return {
        ok: false,
        error: body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`,
        reason: "upstream",
      };
    }

    const orders = (body.data?.orders?.nodes ?? []).map(toOrderTracking);
    console.log(`[order-lookup] customer_id lookup returned ${orders.length} order(s)`);
    return {
      ok: true,
      orders,
      note: orders.length
        ? "Share ONLY the status, delivery schedule, and tracking link/number — never an address, phone number, or payment details."
        : "No orders found for this customer.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Order lookup failed.",
      reason: "upstream",
    };
  }
}

// ---------------------------------------------------------------------------
// Anti-guessing attempt limit (LookupAttempt, keyed by the resolved agent
// thread key — see messenger-agent-tools.server.ts's `context.threadId ??
// context.psid` resolution).
// ---------------------------------------------------------------------------
//
// Five consecutive failed name+zip lookups lock the tool for the calling
// key for 30 minutes. A success clears the counter; so does a fresh mistake
// AFTER the 30-minute window has already expired — otherwise one more wrong
// guess long after the cooldown would silently re-lock the customer for
// another 30 minutes forever, since only a *success* used to clear it.
// All designed-failure — never throws — so a Prisma hiccup here never
// crashes the agent turn; it just fails open (treated as not-locked) since
// availability of support beats a slightly weaker guard on a transient DB
// error.

export async function isLookupLocked(key: string): Promise<boolean> {
  try {
    const attempt = await prisma.lookupAttempt.findUnique({
      where: { key },
      select: { lockedAt: true },
    });
    if (!attempt?.lockedAt) return false;
    const lockedUntil = attempt.lockedAt.getTime() + LOOKUP_LOCKOUT_MINUTES * 60_000;
    return Date.now() < lockedUntil;
  } catch (error) {
    console.warn(
      `[order-lookup] isLookupLocked failed key=${key}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

export async function recordLookupFailure(key: string): Promise<void> {
  try {
    const existing = await prisma.lookupAttempt.findUnique({
      where: { key },
      select: { failures: true, lockedAt: true },
    });
    const lockoutWindowExpired =
      !!existing?.lockedAt &&
      Date.now() >= existing.lockedAt.getTime() + LOOKUP_LOCKOUT_MINUTES * 60_000;
    // A lockout past its window gets a fresh full allowance (MINOR-1 fix)
    // instead of carrying the old count into an immediate re-lock.
    const baseFailures = lockoutWindowExpired ? 0 : (existing?.failures ?? 0);
    const nextFailures = baseFailures + 1;
    const locked = nextFailures >= LOOKUP_FAILURE_THRESHOLD;
    await prisma.lookupAttempt.upsert({
      where: { key },
      create: { key, failures: nextFailures, lockedAt: locked ? new Date() : null },
      update: { failures: nextFailures, lockedAt: locked ? new Date() : null },
    });
    console.log(`[order-lookup] recorded failure key=${key} count=${nextFailures}`);
  } catch (error) {
    console.warn(
      `[order-lookup] recordLookupFailure failed key=${key}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

export async function clearLookupFailures(key: string): Promise<void> {
  try {
    await prisma.lookupAttempt.upsert({
      where: { key },
      create: { key, failures: 0, lockedAt: null },
      update: { failures: 0, lockedAt: null },
    });
  } catch (error) {
    console.warn(
      `[order-lookup] clearLookupFailures failed key=${key}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}
