import { SignJWT } from "jose";

import prisma from "../app/db.server.js";

export interface MintTokenOptions {
  apiKey: string;
  apiSecret: string;
  shopDomain: string; // e.g. hsrwva-nr.myshopify.com
  customerGid: string; // e.g. gid://shopify/Customer/1234567890
  ttlSeconds?: number;
}

/**
 * Mint a Shopify customer-account session token compatible with the
 * delivery-scheduler reschedule route (HS256, aud = API key, dest = shop URL).
 */
export async function mintSessionToken(options: MintTokenOptions): Promise<string> {
  const { apiKey, apiSecret, shopDomain, customerGid, ttlSeconds = 60 } = options;
  const secretKey = new TextEncoder().encode(apiSecret);
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    dest: `https://${shopDomain}`,
    sub: customerGid,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + ttlSeconds)
    .setAudience(apiKey)
    .sign(secretKey);
}

export interface AdminFetchOptions {
  shopDomain: string;
  adminAccessToken?: string; // shpua_… offline token
  query: string;
  variables?: Record<string, unknown>;
}

export interface AdminGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function resolveAdminAccessToken(options: AdminFetchOptions): Promise<string> {
  const explicitToken = options.adminAccessToken?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const offlineSession = await prisma.session.findUnique({
    where: { id: `offline_${options.shopDomain}` },
    select: { accessToken: true },
  });

  if (offlineSession?.accessToken?.trim()) {
    return offlineSession.accessToken.trim();
  }

  const fallbackSession = await prisma.session.findFirst({
    where: {
      shop: options.shopDomain,
      isOnline: false,
    },
    orderBy: { expires: "desc" },
    select: { accessToken: true },
  });

  if (fallbackSession?.accessToken?.trim()) {
    return fallbackSession.accessToken.trim();
  }

  throw new Error(
    `Missing required admin access token for ${options.shopDomain}. Set ADMIN_ACCESS_TOKEN or authenticate the app so the offline session exists in Prisma.`,
  );
}

export async function adminGraphQL<T>(options: AdminFetchOptions): Promise<AdminGraphQLResponse<T>> {
  const adminAccessToken = await resolveAdminAccessToken(options);

  // Keep in lockstep with the app's pinned API version (shopify.app.production.toml).
  const response = await fetch(`https://${options.shopDomain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminAccessToken,
    },
    body: JSON.stringify({ query: options.query, variables: options.variables ?? {} }),
  });

  if (!response.ok) {
    throw new Error(`Admin GraphQL HTTP ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as AdminGraphQLResponse<T>;
}

export const ORDER_DELIVERY_QUERY = `#graphql
  query orderDelivery($id: ID!) {
    order(id: $id) {
      id
      tags
      customAttributes {
        key
        value
      }
      date: metafield(namespace: "custom", key: "date") { value type }
      timeSlot: metafield(namespace: "custom", key: "time_slot") { value type }
    }
  }
`;

export interface OrderCustomAttribute {
  key: string;
  value: string;
}

export interface OrderDelivery {
  order: {
    id: string;
    tags: string[];
    customAttributes: OrderCustomAttribute[];
    date: { value: string; type: string } | null;
    timeSlot: { value: string; type: string } | null;
  } | null;
}
