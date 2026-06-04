# Lalamove Integration Design
**Date:** 2026-06-04  
**Project:** delivery-scheduler (Shopify Embedded App)  
**Market:** Philippines (`PH`)

---

## Overview

Integrate the Lalamove v3 API into the existing delivery-scheduler Shopify app so merchants can manually dispatch deliveries, track driver status, notify customers automatically, and auto-cancel deliveries when Shopify orders are cancelled.

---

## Section 1 — Configuration

Lalamove credentials and store settings are stored as **Shopify metafields** on the `shop` object under namespace `lalamove` — consistent with how `scheduleRules` are stored today.

### Environment Variables (`.env`)

| Variable | Purpose |
|---|---|
| `lalamove_api_key` | Production API key |
| `lalamove_api_secret` | Production API secret |
| `api_key` | Sandbox API key |
| `api_secret` | Sandbox API secret |

### Shop Metafields (namespace: `lalamove`)

| Key | Type | Description |
|---|---|---|
| `market` | string | `PH` |
| `service_type` | string | e.g., `MOTORCYCLE` — fixed per shop |
| `sender_name` | string | Store/sender name shown to driver |
| `sender_phone` | string | Store phone with country code (e.g., `+63`) |
| `sender_address` | string | Full pickup address text |
| `sender_lat` | string | Pickup latitude |
| `sender_lng` | string | Pickup longitude |
| `environment` | string | `production` or `sandbox` |

### Where to Configure

New **"Lalamove Settings"** section added inline to the existing `app.schedule-rules/route.tsx` page — no new route needed.

---

## Section 2 — Data Flow

### 2a. Manual Dispatch (Merchant-triggered)

1. Merchant opens Order Drawer → clicks **"Dispatch via Lalamove"**
2. Dispatch modal appears with pre-dispatch options (see Section 3)
3. Merchant configures options → clicks **"Confirm Dispatch"**
4. App calls `POST /v3/quotations`:
   - `serviceType` — from shop metafield
   - `specialRequests` — `["BUY_FOR_ME"]` and/or `["THERMAL_BAG"]` if selected
   - `scheduleAt` — derived from order's delivery date + time slot
   - `stops[0]` — store address (lat/lng from shop metafield)
   - `stops[1]` — Shopify order shipping address (geocoded)
   - `language` — `en_PH`
5. App immediately calls `POST /v3/orders` with the returned `quotationId`:
   - `sender` — store name, phone, `stopId` from quotation
   - `recipients[0]` — customer name, phone from Shopify order, `remarks` from notes field
   - `metadata.shopifyOrderId` — Shopify order GID
6. Lalamove `orderId`, `shareLink`, initial status stored to Shopify order metafields (namespace: `lalamove`):

| Metafield Key | Initial Value |
|---|---|
| `order_id` | Lalamove order ID |
| `status` | `ASSIGNING_DRIVER` |
| `share_link` | Tracking URL |
| `driver_name` | _(empty)_ |
| `driver_phone` | _(empty)_ |

### 2b. Lalamove Webhooks → `webhooks.lalamove.ts` (new route)

| Webhook Event | Action |
|---|---|
| `DRIVER_ASSIGNED` | Update metafields: `driver_name`, `driver_phone`, `status` → Update Shopify order fulfillment tracking URL with `shareLink` → Shopify auto-sends shipping email to customer |
| `ORDER_STATUS_CHANGED` | Update `lalamove.status` metafield on the Shopify order |
| `POD_STATUS_CHANGED` | Update status to `COMPLETED` |

### 2c. Auto-Cancel → `webhooks.orders.cancelled.ts` (new webhook)

- Triggered when a Shopify order is cancelled
- If order has `lalamove.order_id` metafield → call `DELETE /v3/orders/{orderId}`
- If no Lalamove order exists → skip silently
- Cancellation only works when status is `ASSIGNING_DRIVER` (within 5 min of driver acceptance per Lalamove rules)

---

## Section 3 — UI Changes (Orders Dashboard)

### Dispatch Modal (pre-dispatch confirmation)

Shown when merchant clicks "Dispatch via Lalamove":

```
Dispatch via Lalamove — Order #[number]

Special Requests:
☐ Buy for me (Up to ₱2,000)        ← only shown if payment_gateway === "Cash on Delivery (COD)"
   Auto-fills notes: "COD order. Please prepare ₱[order total]
   for payment at pickup. Thank you!"

☐ Thermal bag                       ← always visible

Notes to driver:
┌────────────────────────────────────┐
│ [editable — auto-filled if Buy     │
│  for me is checked]                │
└────────────────────────────────────┘

Estimated price: ₱[amount]

[ Cancel ]   [ Confirm Dispatch ]
```

**COD Detection:**
```ts
const isCOD = order.payment_gateway === "Cash on Delivery (COD)";
```

**Lalamove API mapping:**
- `specialRequests: ["BUY_FOR_ME"]` — when Buy for me checked
- `specialRequests: ["THERMAL_BAG"]` — when Thermal bag checked
- `recipients[0].remarks` — notes to driver field value

### Order Drawer — Lalamove Status States

**State 1 — Not yet dispatched:**
```
[ Dispatch via Lalamove ]
```

**State 2 — ASSIGNING_DRIVER:**
```
Lalamove Status: Finding driver...
[ Add Priority Fee ]
[ Cancel Delivery ]
```

**State 3 — DRIVER_ASSIGNED / ON_GOING / PICKED_UP:**
```
Lalamove Status:  ● On the way
Driver:           [name]  ·  [phone]
Tracking:         [ Copy link ]  [ Open ]
[ Cancel Delivery ]
```

**State 4 — COMPLETED:**
```
Lalamove Status:  ✓ Delivered
Order:            #[order number]
Driver:           [name]
Tracking:         [ Copy link ]  [ Open ]
```

**State 5 — CANCELED / REJECTED / EXPIRED:**
```
Lalamove Status:  ✗ [Cancelled / Rejected / Expired]
[ Dispatch via Lalamove ]   ← fresh dispatch
```

### Orders Table

New status badge column per row:
- No Lalamove order → no badge
- Has Lalamove order → small badge showing current status (e.g., "On the way", "Delivered", "Cancelled")

---

## Section 4 — Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Quotation expires (5-min window) | Auto re-fetch new quotation before confirming dispatch |
| Lalamove API error on dispatch | Show error in drawer, no metafields saved, merchant can retry |
| Cancel failed (driver already on the way) | Show: "Cannot cancel — driver already accepted the order" |
| Shopify order cancelled, no Lalamove order | Skip silently, no API call |
| Address geocoding failed | Show error in dispatch modal: "Could not locate delivery address. Please verify customer address." |
| `REJECTED` / `EXPIRED` status | Show in drawer, merchant can trigger fresh dispatch |
| Priority fee — `ASSIGNING_DRIVER` only | Hide "Add Priority Fee" button once driver is assigned |

---

## Section 5 — Technical Dependencies

### Geocoding (Delivery Address → lat/lng)

Lalamove requires `coordinates: { lat, lng }` for every stop. Shopify shipping addresses are text only. Resolution:

- Use **Google Maps Geocoding API** to convert Shopify shipping address to coordinates at dispatch time
- `GOOGLE_MAPS_API_KEY` to be added to `.env`
- Geocoding happens server-side in `lalamove.server.ts` before calling `/v3/quotations`
- Cache geocoded coordinates in the Lalamove order metafield to avoid re-geocoding on retry

### `scheduleAt` Conversion

Delivery date (e.g., `2026-06-10`) + time slot (e.g., `9AM-12PM`) → UTC ISO 8601:
- Use the **start** of the time slot as `scheduleAt`
- Apply shop timezone (`Asia/Manila`) from existing `scheduleRules.timezone`
- Example: `2026-06-10 09:00 Asia/Manila` → `2026-06-10T01:00:00Z`
- Reuse existing `parseTimeWindowHour` utility from `app/lib/order-utils.ts`

---

## Section 6 — Files Affected

| File | Change |
|---|---|
| `app/routes/app.schedule-rules/route.tsx` | Add Lalamove Settings section |
| `app/routes/app.orders.tsx` | Dispatch modal, status states, priority fee action |
| `app/components/OrderDrawer.tsx` | Lalamove status UI states per drawer |
| `app/routes/webhooks.lalamove.ts` | New — handle Lalamove webhook events |
| `app/routes/webhooks.orders.cancelled.ts` | New — auto-cancel Lalamove on Shopify cancel |
| `app/lib/lalamove.server.ts` | New — Lalamove API client (quotation, order, cancel, priority fee, geocoding) |
| `app/shopify.server.js` | Register `orders/cancelled` webhook |
| `.env` | Already has keys: `lalamove_api_key`, `lalamove_api_secret`, `api_key`, `api_secret` |

---

## Section 7 — Lalamove API Endpoints Used

| Endpoint | Purpose |
|---|---|
| `POST /v3/quotations` | Get price + quotationId before dispatch |
| `POST /v3/orders` | Place delivery order |
| `GET /v3/orders/{id}` | Poll order status (fallback if webhook missed) |
| `DELETE /v3/orders/{orderId}` | Cancel delivery |
| `POST /v3/orders/{orderId}/priority-fee` | Add priority fee |
| `PATCH /v3/webhook` | Register webhook URL on app install |
| `GET /v3/cities` | Fetch valid serviceType values per market |

---

## Section 8 — Out of Scope (this iteration)

- Multi-stop / route optimization
- Change driver feature
- SMS notifications
- Lalamove wallet balance display
- Scheduled batch dispatch
