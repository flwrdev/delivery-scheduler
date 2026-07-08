# Lalamove Integration Bug Fix Plan

## Background

Two distinct 422 errors appear in the Dispatch Modal:

1. **`ERR_INVALID_FIELD` on `/data/stops/0/coordinates/lng`** — The longitude (and lat) value sent to Lalamove does not match its required numeric pattern.
2. **`ERR_INVALID_FIELD` on `/data/specialRequests/0`** — The special-request enum value sent is not in Lalamove's accepted list for the Philippines market.

Both errors fire at the **quotation stage** (`POST /v3/quotations`) and bubble up as raw JSON error strings shown directly to the merchant.

---

## Root Cause Analysis

### Bug 1 — Coordinate Format (Primary Crash)

**Error:** `does not match pattern '^[+-]?((([1-9]?[0-9]|1[0-7][0-9])(\.[0-9]{1,15})?)|180(\.0{1,15})?)$'` on `stops/0/coordinates/lng`

**Where it originates:** [`lalamove.server.ts` L191–192](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/lib/lalamove.server.ts#L191-L192)

```ts
const { lat, lng } = data.results[0].geometry.location;
return { lat: String(lat), lng: String(lng) };
```

`String(number)` in JavaScript can produce scientific notation for very small or very large numbers (e.g., `"1.234e-5"` or `"1.23456789012345678"`). JavaScript's `Number.prototype.toString()` is **not** guaranteed to produce a plain decimal string. The Lalamove API regex strictly requires a plain decimal, so scientific notation or excess precision causes the 422.

**Also at risk:** the stored `senderLat`/`senderLng` values from Shopify metafields (strings from admin settings) are passed through with `.trim()` but are never validated. If saved with trailing whitespace, units, or leading zeros, they may also fail the pattern.

> [!CAUTION]
> This is the primary crash. All quotation and dispatch calls fail because coordinates are malformed.

---

### Bug 2 — `specialRequests` Invalid Enum Value (Second Error in Screenshot)

**Error:** `value must be one of "PURCHASE_SERVICE_4", "PURCHASE_SERVICE_3", "PURCHASE_SERVICE_2", "PURCHASE_SERVICE_1", "THERMAL_BAG_1", "CASH_ON_DELIVERY", "CASH_ON_DELIVERY_AUTODEDUCT", "QUEUEING_SERVICE"` on `/data/specialRequests/0`

**Where it originates:** [`OrderDrawer.tsx` L236–241](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/components/OrderDrawer.tsx#L236-L241) and [`app.orders.tsx` L735–736](file:///d:/Download/LPC Issue/delivery-scheduler/app/routes/app.orders.tsx#L735-L736)

```ts
// OrderDrawer.tsx — quotation trigger
const specialRequests = [
  buyForMe ? "PURCHASE_SERVICE_1" : null,
  thermalBag ? "THERMAL_BAG_1" : null,
].filter(Boolean).join(",");
```

The values `PURCHASE_SERVICE_1` and `THERMAL_BAG_1` **are** valid for PH. However the error shown in screenshot #2 of **order #3443** shows `PURCHASE_SERVICE_4` in the error list, which means the server-side special request string may include unexpected content.

Two sub-issues:
1. **`filter(Boolean).join(",")` on `null` values** — `filter(Boolean)` correctly removes nulls, but `"PURCHASE_SERVICE_1".join(",")` on a single element still produces the right value. Low risk on its own.
2. **Quote is triggered once on modal open, but dispatch reuses a freshly-built `specialRequests` string** — if state has changed between quote and dispatch, the two calls may send different values, causing the cached quotation to be inconsistent with the dispatch request.
3. **`COD` / `buyForMe` flag mapping** — The checkbox is conditioned on `isCOD` but the actual special-request key sent is `PURCHASE_SERVICE_1`. The Lalamove PH `CASH_ON_DELIVERY` and `CASH_ON_DELIVERY_AUTODEDUCT` enum values are separate. The current "Buy for me" flow correctly uses `PURCHASE_SERVICE_1`, but if `isCOD` is also added independently somewhere, it could produce an invalid combination.

> [!IMPORTANT]
> The quote is auto-triggered once on `showDispatchModal`, but changing the thermal bag or buy-for-me checkboxes **does not re-trigger the quote**. The user sees a stale price and the dispatch may use a different `specialRequests` set than the quote.

---

### Bug 3 — No Quote Re-trigger on Checkbox Change

**Where:** [`OrderDrawer.tsx` L227–254](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/components/OrderDrawer.tsx#L227-L254)

```ts
useEffect(() => {
  // ...
  quoteFetcher.submit({ ..., specialRequests }, { method: "post" });
}, [showDispatchModal]); // ← only fires on modal open
```

Changing `thermalBag` or `buyForMe` never re-fetches the quote. The price shown is always the price without special requests (or whichever state was active at open).

> [!WARNING]
> This leads to a UX discrepancy: the merchant sees "PHP 63" but the actual dispatched cost may differ because the quote used different special requests than the dispatch.

---

### Bug 4 — Raw API Error Exposed to Merchant

**Where:** [`app.orders.tsx` L794–797](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/routes/app.orders.tsx#L794-L797) and [`OrderDrawer.tsx` L890–896](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/components/OrderDrawer.tsx#L890-L896)

```ts
{ ok: false, error: `Quotation failed: ${String(e)}` }
```

The raw Lalamove JSON error (with regex patterns and internal field paths) is rendered verbatim to the merchant. This is the giant red text seen in both screenshots.

---

### Bug 5 — Quotation Expiry Not Enforced at Dispatch Time

**Where:** [`app.orders.tsx` L854–871](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/routes/app.orders.tsx#L854-L871)

The `lalamoveDispatch` action always calls `getQuotation` again independently. This is actually **correct behavior** (avoids the 5-min expiry issue), but it means the special requests must match between the component state and the form submission. Because the quote shown to the user may have been fetched with different `specialRequests` than the dispatch, prices can diverge.

---

## Open Questions

> [!IMPORTANT]
> **Q1:** Should `CASH_ON_DELIVERY` be added as a separate special request when COD is enabled (in addition to or instead of `PURCHASE_SERVICE_1`)? The Lalamove PH API lists them as separate options. Please confirm the desired behavior.

> [!IMPORTANT]
> **Q2:** Should the quote be re-fetched automatically when the user changes checkbox state (thermal bag / buy for me), or is the current "fetch once on open" acceptable with a manual "Refresh Quote" button?

---

## Proposed Changes

### Component 1 — Coordinate Sanitization

#### [MODIFY] [lalamove.server.ts](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/lib/lalamove.server.ts)

**`geocodeAddress` return value** — Replace `String(lat)` / `String(lng)` with `parseFloat(lat).toFixed(7)` to produce a stable plain-decimal string (7 decimal places = ~1cm precision, well within Lalamove's 15-decimal max). Also clamp to the valid domain (`[-90,90]` lat, `[-180,180]` lng).

**New helper `sanitizeCoordinate(value: string): string`** — Parses and validates a stored coordinate string (from metafields). Throws with a clear message if NaN or out of range, so the error shown to the merchant is actionable (e.g., "Sender longitude is invalid — please update Lalamove Settings").

```ts
// Proposed helper
function sanitizeCoordinate(value: string, field: string): string {
  const n = parseFloat(value.trim());
  if (!isFinite(n)) throw new Error(`${field} is not a valid number: "${value}"`);
  return n.toFixed(7); // safe plain decimal, no scientific notation
}
```

Apply `sanitizeCoordinate` to both `senderLat`/`senderLng` (from metafields) and the returned geocode values before building the quotation request.

---

### Component 2 — `specialRequests` Hardening

#### [MODIFY] [app.orders.tsx](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/routes/app.orders.tsx)

Add a whitelist validation for `specialRequests` on the server side before calling Lalamove:

```ts
const VALID_SPECIAL_REQUESTS = new Set([
  "PURCHASE_SERVICE_1", "PURCHASE_SERVICE_2",
  "PURCHASE_SERVICE_3", "PURCHASE_SERVICE_4",
  "THERMAL_BAG_1", "CASH_ON_DELIVERY",
  "CASH_ON_DELIVERY_AUTODEDUCT", "QUEUEING_SERVICE",
]);

const validated = specialRequests.filter(r => VALID_SPECIAL_REQUESTS.has(r));
// use `validated` instead of `specialRequests`
```

Apply in both `lalamoveGetQuote` and `lalamoveDispatch` handlers.

---

### Component 3 — Quote Re-trigger on Checkbox Change

#### [MODIFY] [OrderDrawer.tsx](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/components/OrderDrawer.tsx)

Change the `useEffect` dependency array from `[showDispatchModal]` to `[showDispatchModal, thermalBag, buyForMe]` so the quote refreshes when the user toggles special requests. Add a debounce (300ms) to avoid firing on every render.

```ts
useEffect(() => {
  if (!showDispatchModal || ...) return;
  // debounce with setTimeout or a ref
  const timer = setTimeout(() => {
    quoteFetcher.submit({ ..., specialRequests }, { method: "post" });
  }, 300);
  return () => clearTimeout(timer);
}, [showDispatchModal, thermalBag, buyForMe]);
```

---

### Component 4 — User-Friendly Error Messages

#### [MODIFY] [app.orders.tsx](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/routes/app.orders.tsx)

Parse Lalamove 422 error responses and return a structured, human-readable message:

```ts
function parseLalamoveError(e: unknown): string {
  const raw = String(e);
  // Extract the JSON part and map known error IDs
  try {
    const match = raw.match(/\[(\d+)\]: (\{.*\})/s);
    if (match) {
      const body = JSON.parse(match[2]);
      const errors: Array<{id: string; message: string; detail: string}> = body.errors ?? [];
      return errors.map(err => {
        if (err.id === "ERR_INVALID_FIELD" && err.detail.includes("coordinates")) {
          return "Invalid coordinates — please check the Lalamove Settings for the pickup address.";
        }
        if (err.id === "ERR_INVALID_FIELD" && err.detail.includes("specialRequests")) {
          return `Invalid special request option: ${err.detail}`;
        }
        return err.message || err.id;
      }).join(" | ");
    }
  } catch {}
  return raw;
}
```

#### [MODIFY] [OrderDrawer.tsx](file:///d:/Download/LPC%20Issue/delivery-scheduler/app/components/OrderDrawer.tsx)

The error display area (`quoteFetcher.data?.error`) already exists. No display changes needed — improving the server-side message is sufficient.

---

## Verification Plan

### Automated / Dev Testing
1. Add unit tests for `sanitizeCoordinate` covering: valid `14.5995`, scientific notation `1.23e5`, `NaN`, `-181`, `null`.
2. Add unit tests for `parseLalamoveError` with a real 422 response fixture.
3. Run `npm run typecheck` / `tsc` to ensure no type regressions.

### Manual Verification
1. Open Dispatch Modal for an order → confirm quote price loads without error.
2. Toggle Thermal Bag → confirm price refreshes within ~500ms.
3. Confirm Dispatch submits successfully (no 422 errors).
4. Misconfigure `senderLat` to `"abc"` in Lalamove Settings → confirm a clear, actionable error message appears (not raw JSON).
5. Test with a COD order → confirm `PURCHASE_SERVICE_1` is included and the price reflects the service.
