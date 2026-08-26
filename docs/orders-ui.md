# Orders Operations — `/app/orders` page architecture

> Part of the docs set. System topology: [architecture.md](./architecture.md).
> Write-path contract (the route `action`'s ops): [api.md §2](./api.md) — that
> section stays the source of truth for what mutates what; this doc never
> copies it, only points at it.
>
> **Rewritten 2026-08-26.** The previous version of this file described the
> pre-Polaris page (`OrderDrawer.tsx` + `orders-dashboard.css`, both deleted at
> V2 Phase 5, 2026-07-12) and had rotted badly. The V2 design blueprint and its
> audit remain as historical records: [orders-ops-v2-ux.md](./orders-ops-v2-ux.md),
> [orders-ops-v2-audit.md](./orders-ops-v2-audit.md).
>
> **Maintenance rule:** this doc cites **symbols, never line numbers** — line
> numbers were the old version's fastest-rotting content. Update this doc
> whenever the page's architecture changes (new data source, new modal, new
> hook, changed refresh/write model); routine per-deployment records stay in
> [changelog.md](./changelog.md) + [verification-log.md](./verification-log.md).

The embedded admin's main operating surface: order list table, KPI band,
order-details side panel, and every order-level modal. One route file owns the
loader, the action, and the page composition; everything else on the page is a
props-only component fed from that single loader.

---

## 1. File inventory

| Layer | File | Role |
| --- | --- | --- |
| **Route** | `app/routes/app.orders.tsx` | Loader, `action` (all ops), `shouldRevalidate`, `Extension()` page component, `GET_ORDERS_QUERY`, KPI computations, tab defs, modal wiring (~2,200 lines) |
| Fetcher route | `app/routes/app.orders_.reschedule-rules.ts` | Rules + live booked counts for the Reschedule modal (the page's only secondary fetch) |
| **Table** | `app/components/orders/OrdersIndexTable.tsx` | Polaris `IndexFilters` + `IndexTable`; tabs, sort, search, selection (`useIndexResourceState`), row diff badges |
| **Panel** | `app/components/orders/OrderDetailsPanel.tsx` | Right-side details panel (lazy-loaded chunk), URL-driven via `?order=`; Esc-close scoped by `escDisabled` |
| Panel sections | `app/components/orders/panel/DeliverySection.tsx` | Delivery date/slot/address block; shop-local "today" via `todayISO` prop |
| | `app/components/orders/panel/DeliveryTimeline.tsx` | Reschedule history + Fulfilled/Delivered + email-sent + reminder-conversion entries |
| | `app/components/orders/panel/ItemsSection.tsx`, `panel/badge-tone.ts` | Line items + totals; badge tone mapping |
| **Modals** | `CancelModal`, `ArchiveModal`, `UnarchiveModal`, `AddTagsModal`, `RemoveTagsModal` | Bulk-op confirm modals (post to the route `action`) |
| | `MarkFulfilledModal.tsx` | Fulfill + optional Lalamove Order ID paste (ADR-16 `recordLalamoveOrderId`) |
| | `RescheduleModal.tsx` | Merchant reschedule; rules/capacity via the fetcher route; canonical slot matching via `lib/slot-value` |
| | `SendEmailModal.tsx` | In-app customer-email compose (`sendEmail` op — zero order writes) |
| | `EditDetailsModal.tsx` | Shipping-address rewrite (`editDetails` op); Google Places autocomplete via `lib/google-places.client.ts` + loader's `mapsApiKey` |
| | `SharedTagsModal.tsx`, `KpiProductsModal.tsx` | Row-tags viewer; products-to-prepare KPI drill-down |
| **Hooks** | `app/hooks/useBulkActions.ts` | Fetcher submit + toast + per-op result plumbing for all bulk modals |
| | `app/hooks/useSmartRefresh.ts` | Timed background revalidation (5 min on Today view / 30 min otherwise), pausable |
| | `app/hooks/useOrdersDiff.ts` | Snapshot diff per view → "view changed" banner + new/changed row badges |
| | `app/hooks/useCopyToClipboard.ts` | Panel copy buttons |
| **Shared libs** | `app/lib/order-utils.ts` | Canonical `Order` interface + every formatter/status helper shared by table & panel |
| | `app/lib/delivery-availability.ts` | `getShopLocalDate`, rules types, merchant reschedule validation |
| | `app/lib/slot-value.ts` | `normalizeSlotValueForMatch` / `findSlotOverrideKey` / `slotValuesMatch` — the ONLY legal way to compare slot strings |
| | `app/lib/order-tags.ts` | `MAX_ORDER_TAG_LENGTH` (40 — Shopify's real cap), `buildOrderEventTag` |
| **Services (action side)** | `services/reschedule-order-delivery.server.ts` | The shared reschedule write orchestration (REC-1/2 — same code path as the customer-account reschedule) |
| | `services/send-customer-email.server.ts` | `handleSendEmailOp` — SMTP send + `EmailSendLog` row |
| | `services/update-order-contact.server.ts` | `handleEditDetailsOp` |
| | `services/lalamove-tracking.server.ts` | `recordLalamoveOrderId` (ADR-16 status listener, not dispatch) |
| | `services/schedule-rules.server.ts` | `getScheduleRules` / `getScheduleRulesWithBookedCounts` |
| Styles | `app/styles/order-details-panel.css` | Panel-only styles (imported `?url` via the route's `links()`) |

---

## 2. Single-loader architecture

**One loader feeds everything** — table rows, tab counts, KPI band, and the
details panel all read the same `orders: Order[]` array. No component fetches
order data on its own; the one exception is the Reschedule modal's rules
fetcher (`app.orders_.reschedule-rules`), which fetches schedule rules +
booked counts, never orders.

**URL params are the page state:** `tab`, `search`, `timeWindow`,
`deliveryDate`, `sort`, `after`/`before` (cursor pagination), and `order`
(panel open/close). Refresh/share/back-button all reproduce the exact view.

Loader sequence (all in `app.orders.tsx`):

1. `authenticate.admin(request)` → `admin`, `session`.
2. Parse + validate URL params (bad `deliveryDate`/`sort` fall back to defaults).
3. Build the composite Shopify search query — **server-side filters only**:
   - free-text `search` (input containing `:` is quoted as a literal so typed
     `status:closed` can't widen the view past its guard),
   - tab terms: `unfulfilled` → `fulfillment_status:unfulfilled status:open`;
     `unpaid` → pending/authorized/partially_paid + `status:open`;
     `archived` → `status:closed`; every other view → `-status:closed`
     (NOT `status:open`, so cancelled orders stay visible with a badge).
   - ⚠️ Delivery date/slot terms are deliberately **never** sent: Shopify
     silently ignores metafield search terms unless the definition is indexed
     as filterable (verified live 2026-07-11). All date/slot filtering
     (Today/Tomorrow/This-week tabs, the two toolbar filters) is **client-side**
     over an enlarged page.
4. `pageSize`: **250** when a client-side date/slot filter needs rows to
   filter from (`today`/`tomorrow`/`thisWeek` tab, `deliveryDate` or
   `timeWindow` filter), otherwise **25**. Echoed to the client — see tab
   counts below.
5. Shop timezone via `getScheduleRules(session.shop)` — guarded; a Postgres
   hiccup falls back to the default timezone instead of failing the page.
   `todayISO = getShopLocalDate(shopTimezone)` — the **shop-local** calendar
   day. The client never derives "today" from the browser clock.
6. `admin.graphql(GET_ORDERS_QUERY)` — orders with delivery metafields
   (`custom.date`, `custom.time_slot`, `delivery.*` mirrors,
   `delivery.reschedule_history`), customAttributes, line items, addresses,
   price sets, customer, and `fulfillments { createdAt deliveredAt }` (for the
   timeline's Fulfilled/Delivered entries).
7. **Postgres enrichment, one guarded `Promise.all`:** `emailSendLog` rows
   (panel timeline "email sent" entries) + `occasionReminder` conversions
   (ADR-19) for this page's order ids → attached as `order.emailLog` /
   `order.reminderConversions`. Panel-timeline garnish, not page-critical: a
   Neon cold-start rejection degrades both to empty lists, never 500s the page.
8. `Response.json({...} satisfies LoaderData, { headers: { "Cache-Control": "no-store" } })`
   returning: `orders`, `pageInfo`, `errors`, the echoed filter params,
   `todayISO`, `pageSize`, and `mapsApiKey` (client-exposed by design — the
   Maps JS SDK needs it in the browser; the key must be locked down in Google
   Cloud console to the Cloud Run referrer + Maps JavaScript API/Places API
   (New) only).

**`shouldRevalidate` (REC-7):** toggling the `?order` param (panel open/close)
skips the loader re-run — the panel reads already-loaded data. Everything else
(filters, tabs, cursors, post-action revalidation, `useRevalidator`) keeps
default behavior.

---

## 3. Client composition (`Extension()`)

- **`dateRefs`** — a `useMemo` keyed on `loaderData.todayISO` deriving
  tomorrow/this-week boundaries with UTC arithmetic. Every date tab, overdue
  chip, and "due today" figure runs off it; never off `new Date()`.
- **`displayedOrders`** — the loader page, client-filtered for the
  date/slot views (step 3 above). Table rows, KPIs, and tab counts all
  consume this or the raw `orders` array.
- **KPI band (REC-8: page-scope only)** — Orders count, Revenue (+ avg/order),
  Unpaid (count + pending total), Unfulfilled (+ due today), products-to-prepare
  (opens `KpiProductsModal`), Delivery fees. All `useMemo` computations off the
  loaded page — deliberately not store-wide numbers.
- **Tabs** — `tabDefs`: All / Today / Tomorrow / This week / Unfulfilled /
  Unpaid / Archived. **Count honesty:** counts render only when
  `pageSize >= 250` (a 25-row page can't produce representative counts), get a
  `+` suffix when `pageInfo` says more pages exist, and Archived never shows a
  count (it's excluded from every other view's query, so nothing client-side
  can know it).
- **Details panel** — opened by row click writing `?order=<id>`; the order
  object is `orders.find(o => o.id === selectedOrderId)` — no separate fetch,
  so the panel always reflects the loader's data. Lazy-loaded
  (`lazy(() => import(...))` + `Suspense`). Receives `todayISO` and
  `escDisabled`; **Esc closes the panel only when no modal is open** —
  with a modal up, Esc closes just that modal (`anyModalOpen` in the route:
  `activeModal`, the shared tags modal, or the KPI products modal).
- **Modal state** — one `activeModal` discriminated union in the route
  (`cancel` / `archive` / `unarchive` / `markFulfilled` / `reschedule` /
  `sendEmail` / `editDetails` / `addTags` / `removeTags`), plus the two
  standalone React-state modals (shared tags, KPI products).

---

## 4. Refresh model (how webhook-driven changes reach the page)

No webhook pushes to this page. Webhooks (e.g. `orders/create` delivery sync)
and external actors mutate the Shopify order; the page catches up by re-running
its loader:

- **`useSmartRefresh`** — background revalidation via `useRevalidator`:
  every **5 min on the Today view**, **30 min elsewhere**; **paused** while any
  modal is open or an action is in flight (`refreshPaused = anyModalOpen ||
  actionInFlight`) so a refresh can't yank state out from under an operation.
  Also exposes the manual Refresh button + "last updated" label.
- **`useOrdersDiff`** — snapshots `displayedOrders` per `ordersViewKey`
  (the URL params minus `?order`, since that toggle doesn't reload data).
  After a background refresh changes the view, it raises the info banner and
  badges new/changed rows until dismissed.

---

## 5. Write paths — pointer, not copy

The route `action` dispatches on `_action`:

- **Single-order ops, dispatched before the bulk machinery:** `sendEmail`
  (SMTP compose — writes **nothing** to the Shopify order, logs to
  `EmailSendLog` for the timeline) and `editDetails` (shipping-address
  rewrite — an order write but **not** a delivery write).
- **Bulk ops** (`BulkActionName`, max **100** selected ids): `archive`,
  `unarchive`, `cancel`, `tagsAdd`, `tagsRemove`, `markFulfilled` (+ optional
  Lalamove Order ID → `recordLalamoveOrderId`, ADR-16), `reschedule`.
- The **only delivery write** on this page is the `reschedule` op, which goes
  through the shared `rescheduleOrderDelivery()` service — the same
  orchestration the customer-account reschedule uses (REC-1/2), so merchant
  and customer writes cannot drift.

Which metafields/tags/attributes each op touches, auth, and failure contract:
**[api.md §2](./api.md)** — do not restate it here, and never assume a write
path without checking there first.

---

## 6. Editing guidance

- **Adding a field to the table or panel** takes two edits: `GET_ORDERS_QUERY`
  (fetch it) and the `Order` interface in `order-utils.ts` (type it). Put any
  display formatting in `order-utils.ts`, not inline — the table and panel must
  render values identically.
- **Dates:** anything meaning "today" derives from `loaderData.todayISO` /
  `dateRefs` — never `new Date()` on the client (VA on a non-Manila machine,
  page left open past shop midnight).
- **Slots:** compare slot strings only through `lib/slot-value.ts` helpers —
  raw string equality breaks on legacy formatting variants.
- **Tags:** cap is `MAX_ORDER_TAG_LENGTH` (40) from `lib/order-tags.ts` —
  single-sourced; one over-long tag fails the entire `tagsAdd` call at Shopify.
- **Refresh interactions:** any new modal must join `anyModalOpen` (pauses
  auto-refresh AND scopes the panel's Esc), and any new URL param that changes
  the visible data set must survive `ordersViewKey` (it strips only `?order`).
- After an architectural change here: update this doc + `changelog.md` /
  `verification-log.md` (and `decisions.md` if a decision was made).

---

## 7. Data-flow summary

```
loader (app.orders.tsx)
  ├─ authenticate.admin → build query (server filters; NO metafield terms)
  ├─ getScheduleRules → todayISO (shop-local)          [guarded fallback]
  ├─ admin.graphql(GET_ORDERS_QUERY) → orders: Order[]
  ├─ Promise.all(emailSendLog, occasionReminder)       [guarded → empty]
  └─ Response.json(orders, pageInfo, params, todayISO, pageSize, mapsApiKey)
        │ useLoaderData()                (Cache-Control: no-store)
        ▼
  Extension()
        ├─ dateRefs (todayISO)  ─► tabs / overdue / due-today
        ├─ displayedOrders (client date/slot filters over 25|250-row page)
        │     ├─► KPI band (page-scope useMemos)
        │     └─► OrdersIndexTable ──(row click writes ?order=)──┐
        ├─ useSmartRefresh (5m Today / 30m; paused by modals+actions)
        ├─ useOrdersDiff (per-view snapshot → banner + row badges)
        ▼                                                        │
  ?order= ─► orders.find(id) ─► <Suspense><OrderDetailsPanel/></Suspense>
        │        (props-only; todayISO + escDisabled passed down)
        ▼
  Modals ─► useBulkActions fetcher ─► route action ─► services
             (archive/…/reschedule │ sendEmail │ editDetails)
             contract: api.md §2   └─ revalidate on settle
```
