# Orders Operations UI — List Page + Order Detail Drawer

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Frontend map of the embedded admin `/app/orders` surface: which files render the
order list table and the right-side order detail drawer, where each gets its data,
and how the drawer is opened. For the route's write-path contract (bulk actions,
`markFulfilled`) see [api.md §2](./api.md#2-actual-order-write-paths-the-only-places-that-mutate-delivery-state);
for system topology see [architecture.md](./architecture.md).

**Scope note:** this doc covers the **UI composition and data flow only**. It does
**not** re-document the bulk-action `action` handler — that is [api.md §2](./api.md)'s
job. `/app/orders` is **not** a delivery write path (see the api.md §2 caveat).

---

## File inventory

| Piece | File |
| --- | --- |
| Route: order list page, loader, bulk-action `action`, table render | [`app/routes/app.orders.tsx`](../app/routes/app.orders.tsx) |
| Right-side order detail drawer (component) | [`app/components/OrderDrawer.tsx`](../app/components/OrderDrawer.tsx) |
| Shared types + formatters (used by list AND drawer) | [`app/lib/order-utils.ts`](../app/lib/order-utils.ts) |
| Copy-to-clipboard hook (drawer only) | [`app/hooks/useCopyToClipboard.ts`](../app/hooks/useCopyToClipboard.ts) |
| List page styles | [`app/styles/orders-dashboard.css`](../app/styles/orders-dashboard.css) (imported `?url`) |

---

## 1. Who renders the list table

`app/routes/app.orders.tsx` is the React Router route mounted at `/app/orders`.
Its default export is the `Extension()` component.

- The table is Polaris web components (`<s-table>` / `<s-table-header-row>` /
  `<s-table-body>`), starting around `app.orders.tsx:2045`.
- Rows are produced by `displayedOrders.map((order) => …)` — one `<s-table-row>`
  per order. Columns: select checkbox, order #, item thumbnail, customer, city,
  delivery date, time window, payment, fulfillment, total, tags.
- The KPI cards (Orders / Revenue / Unpaid / Unfulfilled / products-to-prepare /
  delivery fees) are computed client-side with `useMemo` off `displayedOrders`.
- Tabs (All / Today / Tomorrow / This week / Unfulfilled / Unpaid) are URL-driven
  via `?tab=`; tab counts are computed client-side off the loaded `orders`.

## 2. Who renders the drawer

`app/components/OrderDrawer.tsx` exports `OrderDrawer`. It is a **custom CSS panel**
(`<div className="ods-drawer" role="dialog" aria-modal="true">` + `ods-backdrop`),
**not** a Polaris drawer/modal. It renders: header (order name + financial &
fulfillment status badges + total), Delivery section, an optional Delivery Timeline
(reschedule history), Items list + totals (subtotal/shipping/total), an
"Open in Shopify Admin" deep link, and a Tags section with an add-tag form.

The drawer is **lazy-loaded** — `const OrderDrawer = lazy(() => import("../components/OrderDrawer")…)`
(`app.orders.tsx:5`) wrapped in `<Suspense fallback={null}>` (`app.orders.tsx:2491`),
so it ships as a separate chunk that only mounts when a merchant opens an order.

## 3. Where the data comes from

**Both the list and the drawer share one source: the route `loader`.** There is
**no separate fetch for the drawer.**

- The `loader` (`app.orders.tsx:210`) calls `authenticate.admin(request)` then
  `admin.graphql(GET_ORDERS_QUERY, …)`. The query (`GET_ORDERS_QUERY`,
  `app.orders.tsx:53`) fetches `orders(first/after/last/before, query,
  sortKey: CREATED_AT, reverse: true)` including metafields (`custom.date`,
  `custom.time_slot`, `delivery.date`, `delivery.time_slot`,
  `delivery.reschedule_history`), `customAttributes`, `lineItems`,
  `shippingAddress`, `billingAddress`, price sets, and customer.
- The loader returns `orders: Order[]` + `pageInfo` + echoed filter params via
  `Response.json(..., { headers: { "Cache-Control": "no-store" } })`.
- The client reads it with `useLoaderData()` (`app.orders.tsx:918`).
- **Filtering is mostly server-side** — search, timeWindow, deliveryDate, and the
  today/tomorrow/unfulfilled/unpaid tabs are encoded into the Shopify `query`
  string in the loader. **Only** the `thisWeek` tab is client-side filtered
  (`filteredOrders` useMemo, `app.orders.tsx:1119`); `displayedOrders =
  filteredOrders` is what the table and KPIs consume.
- **Pagination** is cursor-based: `handleNextPage`/`handlePreviousPage` write
  `after`/`before` URL params that the loader reads back (this is the UX-01 fix —
  see [known-issues.md](./known-issues.md)).

## 4. How the drawer gets its order when a row is clicked

**State-passed-down via ID lookup — not a URL param, not a separate fetch.**

1. Parent state: `const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)`
   (`app.orders.tsx:949`). **Only the ID is stored**, deliberately, so the drawer
   always reflects fresh loader data (comment at `:948`).
2. Clicking a row's order number, item thumbnail, or customer name calls
   `onClick={() => setSelectedOrderId(order.id)}` (`app.orders.tsx:2249`, `:2339`, `:2364`).
3. The full order object is derived from the loader array:
   `const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null`
   (`app.orders.tsx:950`).
4. When `selectedOrder` is truthy:
   `<Suspense fallback={null}><OrderDrawer order={selectedOrder} onClose={handleCloseDrawer} /></Suspense>`
   (`app.orders.tsx:2490`).
5. Close: `handleCloseDrawer` = `setSelectedOrderId(null)` (`:956`); also triggered
   by the `Escape` key and backdrop click inside the drawer (`OrderDrawer.tsx:113`, `:137`).

## 5. The drawer's only write path

The drawer is otherwise purely presentational. Its **one** write is the add-tag
form: a `tagFetcher.Form method="post"` posting `_action=tagsAdd` + `orderId` + `tags`
(`OrderDrawer.tsx:413`). This submits to the **same route `action`** in
`app.orders.tsx` that serves all bulk actions.

Per [api.md §2](./api.md), this `tagsAdd` is a **freeform tag write only** — it does
**not** write `custom.date` / `custom.time_slot` / `$app.reschedule_*` /
`delivery.*` metafields or `Delivery Date`/`Delivery Time` customAttributes. All
delivery fields shown in the drawer are read-only. `/app/orders` remains a
non-delivery write path (manual-override side channel only; see api.md §2 caveat).

## 6. Shared types & helpers (list AND drawer)

All live in `app/lib/order-utils.ts` and are imported by both files:

- **`Order`** interface (`order-utils.ts:64`) — the canonical shape flowing
  loader → list → drawer prop. Contains `Customer`, `Metafield`, `ShippingAddress`,
  `BillingAddress`, `CustomAttribute`, `LineItem`/`LineItemImage`/`LineItemProduct`,
  `EmailAddress`, `PhoneNumber`.
- **`BadgeTone`** type (`order-utils.ts:91`) — status badge tones.
- **`CustomAttribute`** — used by both; re-exported by the drawer for convenience
  (`OrderDrawer.tsx:34`).

Shared helper functions (subset): `toLocalISODate`, `normalizeDateToISO`,
`formatDeliveryDate`, `formatMoney`, `financialStatusTone`, `fulfillmentStatusTone`,
`isOpenFulfillmentStatus`, `formatStatusLabel`, `tagDisplayLabel`, `getMeaningfulTags`,
`getDeliveryRelativeLabel`, `isDeliveryOverdue`, `getDeliveryDateValue`,
`getDeliveryTimeValue`, `getCustomerName`, `getCity`, `getInstructionValue`.
Drawer-only helpers: `getAttr`, `getFullShippingAddress`, `buildDeliveryInfoText`,
`getRescheduleTimelineEvents`, `hasRescheduleTag`, `formatTimelineDelivery`,
`formatTimelineTimestamp`, `formatTimelineStatus`.

---

## Editing guidance (what to touch, and where)

The drawer holds **no independent data fetch** — it renders props only. To add a
field to the drawer you must change **two** places:

1. `GET_ORDERS_QUERY` in `app.orders.tsx` — fetch the new field (else the drawer
   sees `undefined`).
2. The `Order` interface (and any nested interface) in `order-utils.ts` — if the
   field is a new shape.

Add a formatter to `order-utils.ts` (not inline in the component) if the value
needs display formatting, to keep list/drawer consistent.

---

## Data-flow summary

```
loader (app.orders.tsx)
  └─ admin.graphql(GET_ORDERS_QUERY) ──► orders: Order[]   (Cache-Control: no-store)
        │  useLoaderData()
        ▼
  Extension()
        │  displayedOrders (server-filtered; thisWeek filtered client-side)
        ├─► <s-table> rows ──(onClick)──► setSelectedOrderId(order.id)
        │        selectedOrder = orders.find(id) ◄──────────┘
        ▼
  {selectedOrder && <Suspense><OrderDrawer order={selectedOrder} onClose=…/></Suspense>}
        │
        └─ OrderDrawer: props-only; 1 write = tagsAdd → same route action
```
