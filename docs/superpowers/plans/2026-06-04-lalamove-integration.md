# Lalamove Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Lalamove v3 API into the delivery-scheduler Shopify app — manual dispatch per order, driver status tracking, auto customer email notification on driver assignment, and auto-cancel on Shopify order cancellation.

**Architecture:** Inline integration extending existing routes and components. A new `app/lib/lalamove.server.ts` centralizes all Lalamove API calls. Lalamove order data is stored as Shopify order metafields (namespace `lalamove`). Two new webhook routes handle Lalamove events and Shopify order cancellations. Shopify webhooks are registered via `shopify.app.toml`.

**Tech Stack:** React Router v7 (Remix), TypeScript, Shopify Admin GraphQL API, Lalamove v3 REST API (HMAC-SHA256 auth), Google Maps Geocoding API

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `app/lib/lalamove.server.ts` | **Create** | Lalamove API client: HMAC auth, quotation, place order, cancel, priority fee, geocoding, scheduleAt |
| `app/routes/webhooks.lalamove.ts` | **Create** | Receive Lalamove webhook events (DRIVER_ASSIGNED, ORDER_STATUS_CHANGED, POD_STATUS_CHANGED) |
| `app/routes/webhooks.orders.cancelled.ts` | **Create** | Auto-cancel Lalamove order when Shopify order is cancelled |
| `app/routes/app.schedule-rules/route.tsx` | **Modify** | Add Lalamove Settings section (environment, service type, sender info) |
| `app/routes/app.orders.tsx` | **Modify** | Add `paymentGatewayNames` to query; dispatch / cancel / priority-fee server actions |
| `app/components/OrderDrawer.tsx` | **Modify** | Dispatch modal (Buy for me, Thermal bag, notes) + 5 Lalamove status states |
| `shopify.app.toml` | **Modify** | Register `orders/cancelled` Shopify webhook subscription |

---

## Task 1: Lalamove API Client

**Files:**
- Create: `app/lib/lalamove.server.ts`

- [ ] **Step 1: Create the file with types and HMAC auth**

```typescript
// app/lib/lalamove.server.ts
import crypto from "node:crypto";
import { parseTimeWindowHour } from "./order-utils";

// ─── Config ──────────────────────────────────────────────────────────────────

function getLalamoveConfig() {
  const isProd = process.env.lalamove_environment === "production";
  return {
    apiKey: isProd ? process.env.lalamove_api_key! : process.env.api_key!,
    apiSecret: isProd
      ? process.env.lalamove_api_secret!
      : process.env.api_secret!,
    baseUrl: isProd
      ? "https://rest.lalamove.com"
      : "https://sandbox-rest.lalamove.com",
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function buildAuthHeader(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
  body: string,
): string {
  const time = Date.now().toString();
  const rawSignature = `${time}\r\n${method.toUpperCase()}\r\n${path}\r\n\r\n${body}`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(rawSignature)
    .digest("hex");
  return `hmac ${apiKey}:${time}:${signature}`;
}

// ─── Base Request ─────────────────────────────────────────────────────────────

async function lalamoveRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { apiKey, apiSecret, baseUrl } = getLalamoveConfig();
  const bodyStr = body ? JSON.stringify(body) : "";
  const auth = buildAuthHeader(apiKey, apiSecret, method, path, bodyStr);

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      Accept: "application/json",
      Market: "PH",
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Lalamove ${method} ${path} failed [${res.status}]: ${errorText}`,
    );
  }

  if (res.status === 204 || method === "DELETE") return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LalamoveStop {
  coordinates: { lat: string; lng: string };
  address: string;
}

export interface LalamoveQuotationRequest {
  serviceType: string;
  stops: LalamoveStop[];
  specialRequests?: string[];
  scheduleAt?: string;
  language: string;
}

export interface LalamoveQuotationResponse {
  quotationId: string;
  expiresAt: string;
  priceBreakdown: {
    total: string;
    currency: string;
    base: string;
  };
  stops: Array<LalamoveStop & { stopId: string }>;
}

export interface LalamoveOrderRequest {
  quotationId: string;
  sender: { stopId: string; name: string; phone: string };
  recipients: Array<{
    stopId: string;
    name: string;
    phone: string;
    remarks?: string;
  }>;
  isPODEnabled?: boolean;
  metadata?: Record<string, string>;
}

export interface LalamoveOrderResponse {
  orderId: string;
  quotationId: string;
  status: LalamoveOrderStatus;
  driverId: string;
  shareLink: string;
  priceBreakdown: { total: string; currency: string };
}

export type LalamoveOrderStatus =
  | "ASSIGNING_DRIVER"
  | "ON_GOING"
  | "PICKED_UP"
  | "COMPLETED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

// ─── API Functions ────────────────────────────────────────────────────────────

export async function getQuotation(
  req: LalamoveQuotationRequest,
): Promise<LalamoveQuotationResponse> {
  return lalamoveRequest<LalamoveQuotationResponse>(
    "POST",
    "/v3/quotations",
    req,
  );
}

export async function placeOrder(
  req: LalamoveOrderRequest,
): Promise<LalamoveOrderResponse> {
  return lalamoveRequest<LalamoveOrderResponse>("POST", "/v3/orders", req);
}

export async function cancelLalamoveOrder(orderId: string): Promise<void> {
  await lalamoveRequest<void>("DELETE", `/v3/orders/${orderId}`);
}

export async function addPriorityFee(
  orderId: string,
  priorityFee: string,
  currency: string,
): Promise<void> {
  await lalamoveRequest<void>(
    "POST",
    `/v3/orders/${orderId}/priority-fee`,
    { priorityFee, currency },
  );
}

export async function registerLalamoveWebhook(webhookUrl: string): Promise<void> {
  await lalamoveRequest<void>("PATCH", "/v3/webhook", { url: webhookUrl });
}

// ─── Geocoding ────────────────────────────────────────────────────────────────

export async function geocodeAddress(
  address: string,
): Promise<{ lat: string; lng: string }> {
  const key = process.env.google_maps_api_key;
  if (!key) throw new Error("google_maps_api_key is not set in environment");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    status: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
    }>;
  };

  if (data.status !== "OK" || !data.results[0]) {
    throw new Error(`Geocoding failed (${data.status}): ${address}`);
  }

  const { lat, lng } = data.results[0].geometry.location;
  return { lat: String(lat), lng: String(lng) };
}

// ─── scheduleAt ───────────────────────────────────────────────────────────────
// Asia/Manila = UTC+8, no DST. Subtract 8 hours to convert to UTC.

export function buildScheduleAt(
  deliveryDate: string,
  timeSlot: string,
): string {
  const startHour = parseTimeWindowHour(timeSlot); // e.g. "9AM-12PM" → 9
  const [y, mo, d] = deliveryDate.split("-").map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, startHour - 8, 0, 0);
  return new Date(utcMs).toISOString();
}
```

- [ ] **Step 2: Verify the file compiles with no TypeScript errors**

```bash
cd "D:\Download\LPC Issue\delivery-scheduler"
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors referencing `lalamove.server.ts`. If `parseTimeWindowHour` import fails, check that it is exported from `app/lib/order-utils.ts` (search for `export function parseTimeWindowHour`).

- [ ] **Step 3: Commit**

```bash
git add app/lib/lalamove.server.ts
git commit -m "feat: add Lalamove API client with HMAC auth, geocoding, and scheduleAt"
```

---

## Task 2: Extend Order GraphQL Query

Add Lalamove metafields and `paymentGatewayNames` to the orders query so the drawer can read dispatch state and detect COD.

**Files:**
- Modify: `app/routes/app.orders.tsx`

- [ ] **Step 1: Add fields to `GET_ORDERS_QUERY`**

In `app/routes/app.orders.tsx`, find the `GET_ORDERS_QUERY` string (around line 101). Add the following inside the `node { ... }` block, after `rescheduleHistory`:

```graphql
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
```

- [ ] **Step 2: Add Lalamove fields to the `Order` type in `app/lib/order-utils.ts`**

Find the `Order` interface (or type) in `app/lib/order-utils.ts`. Add:

```typescript
  paymentGatewayNames?: string[];
  lalamoveOrderId?: { value: string } | null;
  lalamoveStatus?: { value: string } | null;
  lalamoveShareLink?: { value: string } | null;
  lalamoveDriverName?: { value: string } | null;
  lalamoveDriverPhone?: { value: string } | null;
```

- [ ] **Step 3: Add helper functions to `app/lib/order-utils.ts`**

Add these two helpers at the bottom of the file:

```typescript
export function getLalamoveOrderId(order: Order): string | null {
  return order.lalamoveOrderId?.value ?? null;
}

export function getLalamoveStatus(order: Order): string | null {
  return order.lalamoveStatus?.value ?? null;
}

export function getLalamoveShareLink(order: Order): string | null {
  return order.lalamoveShareLink?.value ?? null;
}

export function getLalamoveDriverName(order: Order): string | null {
  return order.lalamoveDriverName?.value ?? null;
}

export function getLalamoveDriverPhone(order: Order): string | null {
  return order.lalamoveDriverPhone?.value ?? null;
}

export function isLalamoveCOD(order: Order): boolean {
  return order.paymentGatewayNames?.includes("Cash on Delivery (COD)") ?? false;
}
```

- [ ] **Step 4: Verify TypeScript**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.orders.tsx app/lib/order-utils.ts
git commit -m "feat: add Lalamove metafields and paymentGatewayNames to orders query"
```

---

## Task 3: Lalamove Settings Section

Add a "Lalamove Settings" section to the existing Schedule Rules page so the merchant can configure sender info, service type, and environment once.

**Files:**
- Modify: `app/routes/app.schedule-rules/route.tsx`

- [ ] **Step 1: Add Lalamove settings GraphQL queries and mutations**

In `app/routes/app.schedule-rules/route.tsx`, add these constants near the top (after the imports):

```typescript
const GET_LALAMOVE_SETTINGS_QUERY = `
  query GetLalamoveSettings {
    shop {
      id
      lalamoveEnvironment: metafield(namespace: "lalamove", key: "environment") { value }
      lalamoveServiceType: metafield(namespace: "lalamove", key: "service_type") { value }
      lalamoveSenderName: metafield(namespace: "lalamove", key: "sender_name") { value }
      lalamoveSenderPhone: metafield(namespace: "lalamove", key: "sender_phone") { value }
      lalamoveSenderAddress: metafield(namespace: "lalamove", key: "sender_address") { value }
      lalamoveSenderLat: metafield(namespace: "lalamove", key: "sender_lat") { value }
      lalamoveSenderLng: metafield(namespace: "lalamove", key: "sender_lng") { value }
    }
  }
`;

const SET_LALAMOVE_SETTINGS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;
```

- [ ] **Step 2: Add `LalamoveSettings` interface and default state**

```typescript
interface LalamoveSettings {
  environment: string;
  serviceType: string;
  senderName: string;
  senderPhone: string;
  senderAddress: string;
  senderLat: string;
  senderLng: string;
}

const DEFAULT_LALAMOVE_SETTINGS: LalamoveSettings = {
  environment: "sandbox",
  serviceType: "MOTORCYCLE",
  senderName: "",
  senderPhone: "",
  senderAddress: "",
  senderLat: "",
  senderLng: "",
};
```

- [ ] **Step 3: Load Lalamove settings in the loader**

In the `loader` function, after the existing `getScheduleRulesWithBookedCounts` call, add:

```typescript
  const lalamoveRes = await admin.graphql(GET_LALAMOVE_SETTINGS_QUERY);
  const lalamoveBody = (await lalamoveRes.json()) as {
    data?: {
      shop?: {
        lalamoveEnvironment?: { value: string } | null;
        lalamoveServiceType?: { value: string } | null;
        lalamoveSenderName?: { value: string } | null;
        lalamoveSenderPhone?: { value: string } | null;
        lalamoveSenderAddress?: { value: string } | null;
        lalamoveSenderLat?: { value: string } | null;
        lalamoveSenderLng?: { value: string } | null;
      };
    };
  };
  const shop = lalamoveBody.data?.shop;
  const lalamoveSettings: LalamoveSettings = {
    environment: shop?.lalamoveEnvironment?.value ?? "sandbox",
    serviceType: shop?.lalamoveServiceType?.value ?? "MOTORCYCLE",
    senderName: shop?.lalamoveSenderName?.value ?? "",
    senderPhone: shop?.lalamoveSenderPhone?.value ?? "",
    senderAddress: shop?.lalamoveSenderAddress?.value ?? "",
    senderLat: shop?.lalamoveSenderLat?.value ?? "",
    senderLng: shop?.lalamoveSenderLng?.value ?? "",
  };
```

Return `lalamoveSettings` alongside the existing `rules` in the loader's `Response.json(...)`.

- [ ] **Step 4: Handle `lalamoveSave` action**

In the `action` function, add a new case for `_action === "lalamoveSave"`:

```typescript
  if (payload && typeof payload === "object" && "_action" in payload && payload._action === "lalamoveSave") {
    const s = payload as LalamoveSettings & { _action: string };
    const shopId = `gid://shopify/Shop/${(await admin.graphql(`query { shop { id } }`).then(r => r.json()) as any).data.shop.id.split("/").pop()}`;
    // GET_LALAMOVE_SETTINGS_QUERY already queries shop.id — reuse its response
    const shopGid = lalamoveBody.data?.shop?.id;
    if (!shopGid) return Response.json({ error: "Could not get shop ID" }, { status: 500 });

    const metafields = [
      { ownerId: shopGid, namespace: "lalamove", key: "environment", value: s.environment ?? "sandbox", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "service_type", value: s.serviceType ?? "MOTORCYCLE", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "sender_name", value: s.senderName ?? "", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "sender_phone", value: s.senderPhone ?? "", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "sender_address", value: s.senderAddress ?? "", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "sender_lat", value: s.senderLat ?? "", type: "single_line_text_field" },
      { ownerId: shopGid, namespace: "lalamove", key: "sender_lng", value: s.senderLng ?? "", type: "single_line_text_field" },
    ];

    const saveRes = await admin.graphql(SET_LALAMOVE_SETTINGS_MUTATION, { variables: { metafields } });
    const saveBody = (await saveRes.json()) as { data?: { metafieldsSet?: { userErrors?: { message: string }[] } } };
    const errors = saveBody.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) return Response.json({ error: errors[0].message }, { status: 400 });

    // Register Lalamove webhook URL
    try {
      const { registerLalamoveWebhook } = await import("../lib/lalamove.server");
      const appUrl = process.env.SHOPIFY_APP_URL ?? "";
      await registerLalamoveWebhook(`${appUrl}/webhooks/lalamove`);
    } catch (e) {
      console.warn("[lalamoveSave] webhook registration failed:", e);
    }

    return Response.json({ ok: true });
  }
```

- [ ] **Step 5: Add Lalamove Settings UI section**

In the component JSX, after the last existing `<s-section>` block (before the save button or at the bottom), add:

```tsx
{/* ── Lalamove Settings ─────────────────────────────────────────── */}
<s-section heading="Lalamove Delivery Settings">
  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Environment</label>
      <select
        value={lalamoveForm.environment}
        onChange={(e) => setLalamoveForm(f => ({ ...f, environment: e.target.value }))}
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }}
      >
        <option value="sandbox">Sandbox (Testing)</option>
        <option value="production">Production (Live)</option>
      </select>
    </div>
    <div>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Service Type</label>
      <input
        type="text"
        value={lalamoveForm.serviceType}
        onChange={(e) => setLalamoveForm(f => ({ ...f, serviceType: e.target.value }))}
        placeholder="e.g. MOTORCYCLE"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }}
      />
    </div>
    <div>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Sender Name</label>
      <input type="text" value={lalamoveForm.senderName}
        onChange={(e) => setLalamoveForm(f => ({ ...f, senderName: e.target.value }))}
        placeholder="Store name shown to driver"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }} />
    </div>
    <div>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Sender Phone</label>
      <input type="text" value={lalamoveForm.senderPhone}
        onChange={(e) => setLalamoveForm(f => ({ ...f, senderPhone: e.target.value }))}
        placeholder="+639xxxxxxxxx"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }} />
    </div>
    <div>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Pickup Address</label>
      <input type="text" value={lalamoveForm.senderAddress}
        onChange={(e) => setLalamoveForm(f => ({ ...f, senderAddress: e.target.value }))}
        placeholder="Full store address"
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }} />
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      <div>
        <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Pickup Latitude</label>
        <input type="text" value={lalamoveForm.senderLat}
          onChange={(e) => setLalamoveForm(f => ({ ...f, senderLat: e.target.value }))}
          placeholder="14.5995"
          style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }} />
      </div>
      <div>
        <label style={{ display: "block", marginBottom: 4, fontWeight: 500 }}>Pickup Longitude</label>
        <input type="text" value={lalamoveForm.senderLng}
          onChange={(e) => setLalamoveForm(f => ({ ...f, senderLng: e.target.value }))}
          placeholder="120.9842"
          style={{ width: "100%", padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf" }} />
      </div>
    </div>
    <div>
      <button
        type="button"
        onClick={() => lalamoveFetcher.submit(
          { _action: "lalamoveSave", ...lalamoveForm },
          { method: "post", encType: "application/json" }
        )}
        disabled={lalamoveFetcher.state !== "idle"}
        style={{ padding: "8px 20px", background: "#008060", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 500 }}
      >
        {lalamoveFetcher.state !== "idle" ? "Saving…" : "Save Lalamove Settings"}
      </button>
      {lalamoveFetcher.state === "idle" && lalamoveFetcher.data?.ok && (
        <span style={{ marginLeft: 12, color: "#008060", fontSize: 13 }}>Saved ✓</span>
      )}
      {lalamoveFetcher.state === "idle" && lalamoveFetcher.data?.error && (
        <span style={{ marginLeft: 12, color: "#d82c0d", fontSize: 13 }}>{lalamoveFetcher.data.error}</span>
      )}
    </div>
  </div>
</s-section>
```

Add corresponding state in the component:

```typescript
  const lalamoveData = useLoaderData<typeof loader>();
  const [lalamoveForm, setLalamoveForm] = useState<LalamoveSettings>(
    lalamoveData.lalamoveSettings ?? DEFAULT_LALAMOVE_SETTINGS,
  );
  const lalamoveFetcher = useFetcher<{ ok?: boolean; error?: string }>();
```

- [ ] **Step 6: Typecheck + commit**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
git add app/routes/app.schedule-rules/route.tsx
git commit -m "feat: add Lalamove settings section to schedule-rules page"
```

---

## Task 4: Server-side Dispatch, Cancel, and Priority Fee Actions

Add three new `_action` handlers to `app/routes/app.orders.tsx`.

**Files:**
- Modify: `app/routes/app.orders.tsx`

- [ ] **Step 1: Add GraphQL constants for Lalamove metafield writes**

In `app/routes/app.orders.tsx`, add near the existing mutation constants:

```typescript
const SET_ORDER_LALAMOVE_METAFIELDS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;

const GET_SHOP_LALAMOVE_SETTINGS_QUERY = `
  query GetShopLalamoveSettings {
    shop {
      id
      lalamoveServiceType: metafield(namespace: "lalamove", key: "service_type") { value }
      lalamoveSenderName: metafield(namespace: "lalamove", key: "sender_name") { value }
      lalamoveSenderPhone: metafield(namespace: "lalamove", key: "sender_phone") { value }
      lalamoveSenderAddress: metafield(namespace: "lalamove", key: "sender_address") { value }
      lalamoveSenderLat: metafield(namespace: "lalamove", key: "sender_lat") { value }
      lalamoveSenderLng: metafield(namespace: "lalamove", key: "sender_lng") { value }
    }
  }
`;

const GET_FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 20) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_WITH_TRACKING_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;
```

- [ ] **Step 2: Add helper to write Lalamove metafields to an order**

Add this helper function in `app/routes/app.orders.tsx` (not exported, server-only):

```typescript
async function setLalamoveMetafields(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  orderId: string,
  fields: {
    order_id?: string;
    status?: string;
    share_link?: string;
    driver_name?: string;
    driver_phone?: string;
  },
) {
  const metafields = Object.entries(fields).map(([key, value]) => ({
    ownerId: orderId,
    namespace: "lalamove",
    key,
    value: value ?? "",
    type: "single_line_text_field",
  }));
  await admin.graphql(SET_ORDER_LALAMOVE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });
}
```

- [ ] **Step 3: Add `lalamoveDispatch` action handler**

In the `action` function in `app/routes/app.orders.tsx`, add a new case. Find the existing action switch/if-else chain and add:

```typescript
  // NOTE: ensure `session` is destructured at the top of the action function:
  // const { admin, session } = await authenticate.admin(request);

  if (formAction === "lalamoveDispatch") {
    const orderId = String(formData.get("orderId") ?? "");
    const deliveryDate = String(formData.get("deliveryDate") ?? "");
    const timeSlot = String(formData.get("timeSlot") ?? "");
    const customerName = String(formData.get("customerName") ?? "");
    const customerPhone = String(formData.get("customerPhone") ?? "");
    const deliveryAddress = String(formData.get("deliveryAddress") ?? "");
    const notesToDriver = String(formData.get("notesToDriver") ?? "");
    const specialRequestsRaw = String(formData.get("specialRequests") ?? "");
    const specialRequests = specialRequestsRaw ? specialRequestsRaw.split(",") : [];
    const shopDomain = session.shop; // requires `session` from authenticate.admin(request)

    // Load shop Lalamove settings
    const settingsRes = await admin.graphql(GET_SHOP_LALAMOVE_SETTINGS_QUERY);
    const settingsBody = (await settingsRes.json()) as {
      data?: {
        shop?: {
          lalamoveServiceType?: { value: string } | null;
          lalamoveSenderName?: { value: string } | null;
          lalamoveSenderPhone?: { value: string } | null;
          lalamoveSenderAddress?: { value: string } | null;
          lalamoveSenderLat?: { value: string } | null;
          lalamoveSenderLng?: { value: string } | null;
        };
      };
    };
    const shopSettings = settingsBody.data?.shop;
    const serviceType = shopSettings?.lalamoveServiceType?.value ?? "MOTORCYCLE";
    const senderName = shopSettings?.lalamoveSenderName?.value ?? "";
    const senderPhone = shopSettings?.lalamoveSenderPhone?.value ?? "";
    const senderAddress = shopSettings?.lalamoveSenderAddress?.value ?? "";
    const senderLat = shopSettings?.lalamoveSenderLat?.value ?? "";
    const senderLng = shopSettings?.lalamoveSenderLng?.value ?? "";

    if (!senderLat || !senderLng) {
      return Response.json({ ok: false, error: "Lalamove pickup coordinates not configured. Go to Schedule Rules → Lalamove Settings." }, { status: 400 });
    }

    const {
      getQuotation,
      placeOrder,
      geocodeAddress,
      buildScheduleAt,
    } = await import("../lib/lalamove.server");

    // Geocode delivery address
    let deliveryCoords: { lat: string; lng: string };
    try {
      deliveryCoords = await geocodeAddress(deliveryAddress);
    } catch (e) {
      return Response.json({ ok: false, error: `Could not locate delivery address. Please verify customer address. (${String(e)})` }, { status: 400 });
    }

    const scheduleAt = buildScheduleAt(deliveryDate, timeSlot);

    // Get quotation
    let quotation;
    try {
      quotation = await getQuotation({
        serviceType,
        language: "en_PH",
        scheduleAt,
        specialRequests: specialRequests.length ? specialRequests : undefined,
        stops: [
          { coordinates: { lat: senderLat, lng: senderLng }, address: senderAddress },
          { coordinates: deliveryCoords, address: deliveryAddress },
        ],
      });
    } catch (e) {
      return Response.json({ ok: false, error: `Quotation failed: ${String(e)}` }, { status: 400 });
    }

    const senderStop = quotation.stops[0];
    const recipientStop = quotation.stops[1];

    // Place order
    let lalamoveOrder;
    try {
      lalamoveOrder = await placeOrder({
        quotationId: quotation.quotationId,
        sender: { stopId: senderStop.stopId, name: senderName, phone: senderPhone },
        recipients: [{
          stopId: recipientStop.stopId,
          name: customerName,
          phone: customerPhone,
          remarks: notesToDriver || undefined,
        }],
        metadata: { shopifyOrderId: orderId, shop: shopDomain },
      });
    } catch (e) {
      return Response.json({ ok: false, error: `Order placement failed: ${String(e)}` }, { status: 400 });
    }

    // Save Lalamove data to Shopify order metafields
    await setLalamoveMetafields(admin, orderId, {
      order_id: lalamoveOrder.orderId,
      status: lalamoveOrder.status,
      share_link: lalamoveOrder.shareLink,
    });

    return Response.json({
      ok: true,
      lalamoveOrderId: lalamoveOrder.orderId,
      lalamoveStatus: lalamoveOrder.status,
      lalamoveShareLink: lalamoveOrder.shareLink,
      estimatedPrice: `${lalamoveOrder.priceBreakdown.currency} ${lalamoveOrder.priceBreakdown.total}`,
    });
  }
```

- [ ] **Step 4: Add `lalamoveCancel` action handler**

```typescript
  if (formAction === "lalamoveCancel") {
    const orderId = String(formData.get("orderId") ?? "");
    const lalamoveOrderId = String(formData.get("lalamoveOrderId") ?? "");
    if (!lalamoveOrderId) {
      return Response.json({ ok: false, error: "No Lalamove order to cancel." }, { status: 400 });
    }
    const { cancelLalamoveOrder } = await import("../lib/lalamove.server");
    try {
      await cancelLalamoveOrder(lalamoveOrderId);
    } catch (e) {
      return Response.json({ ok: false, error: `Cancel failed: ${String(e)}` }, { status: 400 });
    }
    await setLalamoveMetafields(admin, orderId, { status: "CANCELED" });
    return Response.json({ ok: true });
  }
```

- [ ] **Step 5: Add `lalamovePriorityFee` action handler**

```typescript
  if (formAction === "lalamovePriorityFee") {
    const lalamoveOrderId = String(formData.get("lalamoveOrderId") ?? "");
    const priorityFee = String(formData.get("priorityFee") ?? "");
    const currency = String(formData.get("currency") ?? "PHP");
    if (!lalamoveOrderId || !priorityFee) {
      return Response.json({ ok: false, error: "Missing order ID or fee amount." }, { status: 400 });
    }
    const { addPriorityFee } = await import("../lib/lalamove.server");
    try {
      await addPriorityFee(lalamoveOrderId, priorityFee, currency);
    } catch (e) {
      return Response.json({ ok: false, error: `Priority fee failed: ${String(e)}` }, { status: 400 });
    }
    return Response.json({ ok: true });
  }
```

- [ ] **Step 6: Add `lalamoveGetQuote` action (for pre-dispatch price preview)**

```typescript
  if (formAction === "lalamoveGetQuote") {
    const deliveryAddress = String(formData.get("deliveryAddress") ?? "");
    const deliveryDate = String(formData.get("deliveryDate") ?? "");
    const timeSlot = String(formData.get("timeSlot") ?? "");
    const specialRequestsRaw = String(formData.get("specialRequests") ?? "");
    const specialRequests = specialRequestsRaw ? specialRequestsRaw.split(",") : [];

    const settingsRes = await admin.graphql(GET_SHOP_LALAMOVE_SETTINGS_QUERY);
    const settingsBody = (await settingsRes.json()) as { data?: { shop?: { lalamoveServiceType?: { value: string } | null; lalamoveSenderLat?: { value: string } | null; lalamoveSenderLng?: { value: string } | null; lalamoveSenderAddress?: { value: string } | null } } };
    const shopSettings = settingsBody.data?.shop;
    const serviceType = shopSettings?.lalamoveServiceType?.value ?? "MOTORCYCLE";
    const senderLat = shopSettings?.lalamoveSenderLat?.value ?? "";
    const senderLng = shopSettings?.lalamoveSenderLng?.value ?? "";
    const senderAddress = shopSettings?.lalamoveSenderAddress?.value ?? "";

    if (!senderLat || !senderLng) {
      return Response.json({ ok: false, error: "Pickup coordinates not configured." }, { status: 400 });
    }

    const { getQuotation, geocodeAddress, buildScheduleAt } = await import("../lib/lalamove.server");

    let deliveryCoords: { lat: string; lng: string };
    try {
      deliveryCoords = await geocodeAddress(deliveryAddress);
    } catch (e) {
      return Response.json({ ok: false, error: `Cannot geocode address: ${String(e)}` }, { status: 400 });
    }

    try {
      const quotation = await getQuotation({
        serviceType,
        language: "en_PH",
        scheduleAt: buildScheduleAt(deliveryDate, timeSlot),
        specialRequests: specialRequests.length ? specialRequests : undefined,
        stops: [
          { coordinates: { lat: senderLat, lng: senderLng }, address: senderAddress },
          { coordinates: deliveryCoords, address: deliveryAddress },
        ],
      });
      return Response.json({
        ok: true,
        quotationId: quotation.quotationId,
        price: `${quotation.priceBreakdown.currency} ${quotation.priceBreakdown.total}`,
        expiresAt: quotation.expiresAt,
      });
    } catch (e) {
      return Response.json({ ok: false, error: `Quotation failed: ${String(e)}` }, { status: 400 });
    }
  }
```

- [ ] **Step 7: Typecheck + commit**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
git add app/routes/app.orders.tsx
git commit -m "feat: add lalamoveDispatch, lalamoveCancel, lalamovePriorityFee, lalamoveGetQuote actions"
```

---

## Task 5: Dispatch Modal + Order Drawer Lalamove UI States

**Files:**
- Modify: `app/components/OrderDrawer.tsx`

- [ ] **Step 1: Add Lalamove imports to `OrderDrawer.tsx`**

Add to the existing import from `../lib/order-utils`:

```typescript
  getLalamoveOrderId,
  getLalamoveStatus,
  getLalamoveShareLink,
  getLalamoveDriverName,
  getLalamoveDriverPhone,
  isLalamoveCOD,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getFullShippingAddress,
  getCustomerName,
  getOrderPhone,
```

(Some of these may already be imported; only add the ones missing.)

- [ ] **Step 2: Add dispatch modal state hooks**

In the `OrderDrawer` component body, after the existing `useState` calls, add:

```typescript
  const lalamoveFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    lalamoveOrderId?: string;
    lalamoveStatus?: string;
    lalamoveShareLink?: string;
    price?: string;
    quotationId?: string;
    expiresAt?: string;
  }>();
  const cancelFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const priorityFetcher = useFetcher<{ ok: boolean; error?: string }>();

  const quoteFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    price?: string;
    quotationId?: string;
  }>();

  const [showDispatchModal, setShowDispatchModal] = useState(false);
  const [buyForMe, setBuyForMe] = useState(false);
  const [thermalBag, setThermalBag] = useState(false);
  const [driverNotes, setDriverNotes] = useState("");
  const [priorityFeeInput, setPriorityFeeInput] = useState("");

  const isCOD = isLalamoveCOD(order);
  const lalamoveOrderId = getLalamoveOrderId(order);
  const lalamoveStatus = getLalamoveStatus(order) as import("../lib/lalamove.server").LalamoveOrderStatus | null;
  const shareLink = getLalamoveShareLink(order);
  const driverName = getLalamoveDriverName(order);
  const driverPhone = getLalamoveDriverPhone(order);
  const deliveryDate = getDeliveryDateValue(order);
  const timeSlot = getDeliveryTimeValue(order);
  const fullAddress = getFullShippingAddress(order);
  const customerName = getCustomerName(order);
  const customerPhone = getOrderPhone(order);
  const orderTotal = order.currentTotalPriceSet?.shopMoney?.amount ?? "";
  const orderCurrency = order.currentTotalPriceSet?.shopMoney?.currencyCode ?? "PHP";
  const orderNumber = order.name ?? `#${orderId}`;

  // Auto-fill notes when Buy for me is checked
  useEffect(() => {
    if (buyForMe) {
      setDriverNotes(
        `COD order. Please prepare ${orderCurrency} ${orderTotal} for payment at pickup. Thank you!`
      );
    } else {
      setDriverNotes("");
    }
  }, [buyForMe, orderCurrency, orderTotal]);

  // Auto-fetch estimated price when dispatch modal opens
  useEffect(() => {
    if (showDispatchModal && deliveryDate && deliveryDate !== "—" && timeSlot && timeSlot !== "—" && fullAddress) {
      const specialRequests = [
        buyForMe ? "BUY_FOR_ME" : null,
        thermalBag ? "THERMAL_BAG" : null,
      ].filter(Boolean).join(",");
      quoteFetcher.submit(
        { _action: "lalamoveGetQuote", deliveryAddress: fullAddress, deliveryDate, timeSlot, specialRequests },
        { method: "post" },
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDispatchModal]);
```

- [ ] **Step 3: Add the `LalamoveSection` component inline**

Add this component inside the `OrderDrawer.tsx` file, before the `OrderDrawer` function:

```typescript
type LalamoveStatus =
  | "ASSIGNING_DRIVER"
  | "ON_GOING"
  | "PICKED_UP"
  | "COMPLETED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

function LalamoveStatusLabel({ status }: { status: LalamoveStatus | null }) {
  if (!status) return null;
  const map: Record<LalamoveStatus, { label: string; color: string }> = {
    ASSIGNING_DRIVER: { label: "Finding driver…", color: "#f59e0b" },
    ON_GOING: { label: "● On the way", color: "#2563eb" },
    PICKED_UP: { label: "● Picked up", color: "#2563eb" },
    COMPLETED: { label: "✓ Delivered", color: "#16a34a" },
    CANCELED: { label: "✗ Cancelled", color: "#dc2626" },
    REJECTED: { label: "✗ Rejected", color: "#dc2626" },
    EXPIRED: { label: "✗ Expired", color: "#dc2626" },
  };
  const { label, color } = map[status] ?? { label: status, color: "#6b7280" };
  return <span style={{ color, fontWeight: 600, fontSize: 13 }}>{label}</span>;
}
```

- [ ] **Step 4: Add the Lalamove section JSX to the drawer**

In the drawer JSX, find the `{/* Admin link + fulfillment CTA */}` section (around line 470). Insert the following BEFORE that section:

```tsx
          {/* ── Lalamove Delivery ───────────────────────────────────────── */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Lalamove Delivery</p>

            {/* State 1 — Not dispatched */}
            {!lalamoveOrderId && (
              <button
                className="ods-action-link"
                style={{ background: "#ff6600", color: "#fff", padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: 600 }}
                onClick={() => setShowDispatchModal(true)}
              >
                Dispatch via Lalamove
              </button>
            )}

            {/* State 2 — ASSIGNING_DRIVER */}
            {lalamoveOrderId && lalamoveStatus === "ASSIGNING_DRIVER" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <LalamoveStatusLabel status="ASSIGNING_DRIVER" />
                <priorityFetcher.Form method="post">
                  <input type="hidden" name="_action" value="lalamovePriorityFee" />
                  <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                  <input type="hidden" name="currency" value={orderCurrency} />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="number"
                      name="priorityFee"
                      placeholder="Priority fee amount"
                      value={priorityFeeInput}
                      onChange={(e) => setPriorityFeeInput(e.target.value)}
                      style={{ width: 140, padding: "6px 10px", borderRadius: 6, border: "1px solid #c9cccf", fontSize: 13 }}
                    />
                    <button
                      type="submit"
                      disabled={!priorityFeeInput || priorityFetcher.state !== "idle"}
                      className="ods-action-link"
                      style={{ padding: "6px 12px" }}
                    >
                      {priorityFetcher.state !== "idle" ? "Adding…" : "Add Priority Fee"}
                    </button>
                  </div>
                </priorityFetcher.Form>
                <cancelFetcher.Form method="post">
                  <input type="hidden" name="_action" value="lalamoveCancel" />
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                  <button
                    type="submit"
                    disabled={cancelFetcher.state !== "idle"}
                    style={{ padding: "6px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}
                  >
                    {cancelFetcher.state !== "idle" ? "Cancelling…" : "Cancel Delivery"}
                  </button>
                </cancelFetcher.Form>
                {cancelFetcher.data?.error && (
                  <p style={{ color: "#dc2626", fontSize: 12, margin: 0 }}>{cancelFetcher.data.error}</p>
                )}
              </div>
            )}

            {/* State 3 — ON_GOING / PICKED_UP */}
            {lalamoveOrderId && (lalamoveStatus === "ON_GOING" || lalamoveStatus === "PICKED_UP") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <LalamoveStatusLabel status={lalamoveStatus} />
                {driverName && <span style={{ fontSize: 13 }}>Driver: <strong>{driverName}</strong> · {driverPhone}</span>}
                {shareLink && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="ods-action-link" onClick={() => navigator.clipboard.writeText(shareLink)}>Copy tracking link</button>
                    <a href={shareLink} target="_blank" rel="noreferrer" className="ods-action-link">Open</a>
                  </div>
                )}
                <cancelFetcher.Form method="post">
                  <input type="hidden" name="_action" value="lalamoveCancel" />
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                  <button type="submit" disabled={cancelFetcher.state !== "idle"}
                    style={{ padding: "6px 14px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
                    {cancelFetcher.state !== "idle" ? "Cancelling…" : "Cancel Delivery"}
                  </button>
                </cancelFetcher.Form>
              </div>
            )}

            {/* State 4 — COMPLETED */}
            {lalamoveOrderId && lalamoveStatus === "COMPLETED" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <LalamoveStatusLabel status="COMPLETED" />
                <span style={{ fontSize: 13 }}>Order: <strong>{orderNumber}</strong></span>
                {driverName && <span style={{ fontSize: 13 }}>Driver: <strong>{driverName}</strong></span>}
                {shareLink && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="ods-action-link" onClick={() => navigator.clipboard.writeText(shareLink)}>Copy tracking link</button>
                    <a href={shareLink} target="_blank" rel="noreferrer" className="ods-action-link">Open</a>
                  </div>
                )}
              </div>
            )}

            {/* State 5 — CANCELED / REJECTED / EXPIRED */}
            {lalamoveOrderId && (lalamoveStatus === "CANCELED" || lalamoveStatus === "REJECTED" || lalamoveStatus === "EXPIRED") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <LalamoveStatusLabel status={lalamoveStatus} />
                <button
                  className="ods-action-link"
                  style={{ background: "#ff6600", color: "#fff", padding: "7px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: 600 }}
                  onClick={() => setShowDispatchModal(true)}
                >
                  Dispatch via Lalamove
                </button>
              </div>
            )}
          </div>

          {/* ── Dispatch Modal ──────────────────────────────────────────────── */}
          {showDispatchModal && (
            <div style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
              zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                background: "#fff", borderRadius: 12, padding: 28, width: 420,
                maxWidth: "90vw", boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              }}>
                <p style={{ fontWeight: 700, fontSize: 16, margin: "0 0 16px" }}>
                  Dispatch via Lalamove — {orderNumber}
                </p>

                <p style={{ fontWeight: 600, fontSize: 13, margin: "0 0 10px" }}>Special Requests</p>

                {isCOD && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={buyForMe} onChange={(e) => setBuyForMe(e.target.checked)} />
                    Buy for me (Up to ₱2,000)
                  </label>
                )}

                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={thermalBag} onChange={(e) => setThermalBag(e.target.checked)} />
                  Thermal bag
                </label>

                <p style={{ fontWeight: 600, fontSize: 13, margin: "0 0 6px" }}>Notes to driver</p>
                <textarea
                  value={driverNotes}
                  onChange={(e) => setDriverNotes(e.target.value)}
                  rows={3}
                  maxLength={500}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #c9cccf", fontSize: 13, resize: "vertical", boxSizing: "border-box" }}
                  placeholder="Instructions for the driver…"
                />
                <p style={{ fontSize: 11, color: "#6b7280", margin: "2px 0 16px" }}>{500 - driverNotes.length} characters left</p>

                {/* Estimated price */}
                <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12, marginBottom: 12 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Estimated price: </span>
                  {quoteFetcher.state !== "idle" ? (
                    <span style={{ fontSize: 13, color: "#6b7280" }}>Fetching…</span>
                  ) : quoteFetcher.data?.price ? (
                    <span style={{ fontSize: 13, color: "#111827", fontWeight: 700 }}>{quoteFetcher.data.price}</span>
                  ) : quoteFetcher.data?.error ? (
                    <span style={{ fontSize: 13, color: "#dc2626" }}>{quoteFetcher.data.error}</span>
                  ) : (
                    <span style={{ fontSize: 13, color: "#6b7280" }}>—</span>
                  )}
                </div>

                {lalamoveFetcher.data?.error && (
                  <p style={{ color: "#dc2626", fontSize: 13, margin: "0 0 12px" }}>{lalamoveFetcher.data.error}</p>
                )}

                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setShowDispatchModal(false)}
                    style={{ padding: "8px 18px", border: "1px solid #c9cccf", borderRadius: 6, background: "#fff", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <lalamoveFetcher.Form
                    method="post"
                    onSubmit={() => setShowDispatchModal(false)}
                    style={{ margin: 0 }}
                  >
                    <input type="hidden" name="_action" value="lalamoveDispatch" />
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="deliveryDate" value={deliveryDate} />
                    <input type="hidden" name="timeSlot" value={timeSlot} />
                    <input type="hidden" name="customerName" value={customerName} />
                    <input type="hidden" name="customerPhone" value={customerPhone} />
                    <input type="hidden" name="deliveryAddress" value={fullAddress} />
                    <input type="hidden" name="notesToDriver" value={driverNotes} />
                    <input
                      type="hidden"
                      name="specialRequests"
                      value={[
                        buyForMe ? "BUY_FOR_ME" : null,
                        thermalBag ? "THERMAL_BAG" : null,
                      ].filter(Boolean).join(",")}
                    />
                    <button
                      type="submit"
                      disabled={lalamoveFetcher.state !== "idle"}
                      style={{ padding: "8px 20px", background: "#ff6600", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
                    >
                      {lalamoveFetcher.state !== "idle" ? "Dispatching…" : "Confirm Dispatch"}
                    </button>
                  </lalamoveFetcher.Form>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Typecheck + verify in dev server**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
```

Open an order in the Orders Dashboard. Verify:
- "Dispatch via Lalamove" button appears in the drawer
- Clicking it opens the dispatch modal
- COD order shows "Buy for me" checkbox; non-COD hides it
- "Thermal bag" always visible
- Checking "Buy for me" auto-fills the notes textarea
- "Confirm Dispatch" submits without JS error

- [ ] **Step 6: Commit**

```bash
git add app/components/OrderDrawer.tsx
git commit -m "feat: add Lalamove dispatch modal and status states to OrderDrawer"
```

---

## Task 6: Lalamove Webhook Handler

Receives `DRIVER_ASSIGNED`, `ORDER_STATUS_CHANGED`, and `POD_STATUS_CHANGED` events from Lalamove and updates the Shopify order metafields. On `DRIVER_ASSIGNED`, also creates a Shopify fulfillment with tracking URL to trigger the customer shipping notification email.

**Files:**
- Create: `app/routes/webhooks.lalamove.ts`

- [ ] **Step 1: Create the webhook handler**

```typescript
// app/routes/webhooks.lalamove.ts
import { unauthenticated } from "../shopify.server";

const SET_ORDER_LALAMOVE_METAFIELDS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message }
    }
  }
`;

const GET_FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 30) {
            nodes { id remainingQuantity }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

interface LalamoveWebhookPayload {
  eventType: string;
  orderId?: string;
  status?: string;
  driverId?: string;
  driver?: {
    name: string;
    phone: string;
  };
  metadata?: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setOrderMetafields(
  admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"],
  shopifyOrderId: string,
  fields: Record<string, string>,
) {
  const metafields = Object.entries(fields).map(([key, value]) => ({
    ownerId: shopifyOrderId,
    namespace: "lalamove",
    key,
    value,
    type: "single_line_text_field",
  }));
  await admin.graphql(SET_ORDER_LALAMOVE_METAFIELDS_MUTATION, {
    variables: { metafields },
  });
}

export const action = async ({ request }: { request: Request }) => {
  // Lalamove sends POST with JSON payload
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: LalamoveWebhookPayload;
  try {
    payload = (await request.json()) as LalamoveWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const shopifyOrderId = payload.metadata?.shopifyOrderId;
  const shop = payload.metadata?.shop;

  if (!shopifyOrderId || !shop) {
    console.warn("[webhooks/lalamove] Missing shopifyOrderId or shop in metadata. Skipping.");
    return new Response(null, { status: 200 });
  }

  const { admin } = await unauthenticated.admin(shop);

  const { eventType } = payload;

  if (eventType === "DRIVER_ASSIGNED") {
    const driverName = payload.driver?.name ?? "";
    const driverPhone = payload.driver?.phone ?? "";

    // Update order metafields with driver info + status
    await setOrderMetafields(admin, shopifyOrderId, {
      status: "ON_GOING",
      driver_name: driverName,
      driver_phone: driverPhone,
    });

    // Create Shopify fulfillment with tracking URL to trigger customer email
    try {
      const foRes = await admin.graphql(GET_FULFILLMENT_ORDERS_QUERY, {
        variables: { id: shopifyOrderId },
      });
      const foBody = (await foRes.json()) as {
        data?: {
          order?: {
            fulfillmentOrders?: {
              nodes: Array<{
                id: string;
                status: string;
                lineItems: { nodes: Array<{ id: string; remainingQuantity: number }> };
              }>;
            };
          };
        };
      };

      const openFO = foBody.data?.order?.fulfillmentOrders?.nodes?.find(
        (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS",
      );

      if (openFO) {
        const lineItemsByFulfillmentOrder = [
          {
            fulfillmentOrderId: openFO.id,
            fulfillmentOrderLineItems: openFO.lineItems.nodes
              .filter((li) => li.remainingQuantity > 0)
              .map((li) => ({ id: li.id, quantity: li.remainingQuantity })),
          },
        ];

        // Get share link from metafield
        const shareLinkRes = await admin.graphql(`
          query { order(id: "${shopifyOrderId}") {
            lalamoveShareLink: metafield(namespace: "lalamove", key: "share_link") { value }
          }}
        `);
        const shareLinkBody = (await shareLinkRes.json()) as {
          data?: { order?: { lalamoveShareLink?: { value: string } | null } };
        };
        const trackingUrl = shareLinkBody.data?.order?.lalamoveShareLink?.value ?? "";

        await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
          variables: {
            fulfillment: {
              lineItemsByFulfillmentOrder,
              notifyCustomer: true,
              trackingInfo: trackingUrl
                ? { url: trackingUrl, company: "Lalamove" }
                : undefined,
            },
          },
        });
      }
    } catch (e) {
      console.warn("[webhooks/lalamove] Fulfillment creation failed:", e);
    }
  }

  if (eventType === "ORDER_STATUS_CHANGED" && payload.status) {
    await setOrderMetafields(admin, shopifyOrderId, {
      status: payload.status,
    });
  }

  if (eventType === "POD_STATUS_CHANGED") {
    await setOrderMetafields(admin, shopifyOrderId, {
      status: "COMPLETED",
    });
  }

  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Typecheck**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add app/routes/webhooks.lalamove.ts
git commit -m "feat: add Lalamove webhook handler for driver assigned, status, and POD events"
```

---

## Task 7: Orders Cancelled Webhook + toml Registration

Auto-cancel the Lalamove delivery when a Shopify order is cancelled. Register the new webhook in `shopify.app.toml`.

**Files:**
- Create: `app/routes/webhooks.orders.cancelled.ts`
- Modify: `shopify.app.toml`

- [ ] **Step 1: Create the orders cancelled webhook handler**

```typescript
// app/routes/webhooks.orders.cancelled.ts
import { authenticate, unauthenticated } from "../shopify.server";
import { cancelLalamoveOrder } from "../lib/lalamove.server";

const GET_LALAMOVE_ORDER_ID_QUERY = `
  query GetLalamoveOrderId($id: ID!) {
    order(id: $id) {
      lalamoveOrderId: metafield(namespace: "lalamove", key: "order_id") { value }
      lalamoveStatus: metafield(namespace: "lalamove", key: "status") { value }
    }
  }
`;

const SET_LALAMOVE_STATUS_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: { request: Request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  const orderPayload = payload as Record<string, unknown>;

  const numericId = orderPayload.id;
  if (!numericId) return new Response(null, { status: 200 });

  const shopifyOrderGid = `gid://shopify/Order/${numericId}`;

  const { admin } = await unauthenticated.admin(shop);

  // Check if this order has a Lalamove delivery
  const metaRes = await admin.graphql(GET_LALAMOVE_ORDER_ID_QUERY, {
    variables: { id: shopifyOrderGid },
  });
  const metaBody = (await metaRes.json()) as {
    data?: {
      order?: {
        lalamoveOrderId?: { value: string } | null;
        lalamoveStatus?: { value: string } | null;
      };
    };
  };

  const lalamoveOrderId = metaBody.data?.order?.lalamoveOrderId?.value;
  const lalamoveStatus = metaBody.data?.order?.lalamoveStatus?.value;

  if (!lalamoveOrderId) {
    console.log("[orders/cancelled] No Lalamove order — skipping.");
    return new Response(null, { status: 200 });
  }

  // Only cancel if driver hasn't been picked up yet
  const cancellableStatuses = ["ASSIGNING_DRIVER", "ON_GOING"];
  if (!cancellableStatuses.includes(lalamoveStatus ?? "")) {
    console.log(`[orders/cancelled] Lalamove status ${lalamoveStatus} — cannot cancel. Skipping.`);
    return new Response(null, { status: 200 });
  }

  try {
    await cancelLalamoveOrder(lalamoveOrderId);
    console.log(`[orders/cancelled] Cancelled Lalamove order ${lalamoveOrderId}`);
  } catch (e) {
    console.warn(`[orders/cancelled] Cancel failed for Lalamove order ${lalamoveOrderId}:`, e);
  }

  // Update status metafield regardless of cancel result
  await admin.graphql(SET_LALAMOVE_STATUS_MUTATION, {
    variables: {
      metafields: [{
        ownerId: shopifyOrderGid,
        namespace: "lalamove",
        key: "status",
        value: "CANCELED",
        type: "single_line_text_field",
      }],
    },
  });

  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Add `orders/cancelled` subscription to `shopify.app.toml`**

In `shopify.app.toml`, find the `[[webhooks.subscriptions]]` block for `orders/create` and add after it:

```toml
  [[webhooks.subscriptions]]
  topics = [ "orders/cancelled" ]
  uri = "/webhooks/orders/cancelled"
```

- [ ] **Step 3: Deploy the toml change**

```bash
shopify app deploy
```

This registers the new webhook with Shopify. Confirm `orders/cancelled` appears in the Partner Dashboard under Webhooks.

- [ ] **Step 4: Typecheck + commit**

```bash
npx react-router typegen && npx tsc --noEmit 2>&1 | head -30
git add app/routes/webhooks.orders.cancelled.ts shopify.app.toml
git commit -m "feat: auto-cancel Lalamove order on Shopify order cancellation"
```

---

## Manual Verification Checklist

After all tasks are complete, verify end-to-end with a **sandbox** Lalamove account:

- [ ] Go to Schedule Rules → Lalamove Settings. Enter sandbox credentials (sender address, lat/lng, service type). Save. Check browser console for no errors.
- [ ] Open Orders Dashboard → open any order with a delivery date and time slot.
- [ ] Click **Dispatch via Lalamove** — dispatch modal appears.
- [ ] For a COD order: "Buy for me" checkbox is visible and auto-fills notes when checked.
- [ ] "Thermal bag" checkbox is always visible.
- [ ] Click **Confirm Dispatch** — drawer shows "Finding driver…" status.
- [ ] In Lalamove sandbox dashboard, confirm the order was created with correct pickup/dropoff.
- [ ] Simulate `DRIVER_ASSIGNED` webhook by POSTing test payload to `/webhooks/lalamove` with correct `metadata.shopifyOrderId` and `metadata.shop`.
- [ ] Verify order drawer shows driver name + phone + "On the way" status.
- [ ] Verify customer received Shopify shipping notification email with tracking link.
- [ ] Cancel the Shopify order → verify Lalamove order is also cancelled in the sandbox dashboard.
