# Orders Operations V2 — UX Architecture (Polaris React rewrite)

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).
> **Status: DESIGN FINAL (locked 2026-07-11 — two decision batches, see §10/§10a).
> Phase 0 shipped; Phases 1–5 not yet built.** This doc is the design blueprint
> approved before code. Supersedes the presentation half of
> [orders-ui.md](./orders-ui.md) once shipped; the data-flow half of orders-ui.md
> stays valid.

Goal: make `/app/orders` feel like a **native Shopify Admin Orders page** — same
interaction model, same visual language — using **Polaris React** components only.
The merchant should not need to leave the app to read order data. **All business
logic, GraphQL queries/mutations, services, metafields, and validation rules are
preserved**; only the presentation + interaction layer changes — with ONE approved
structural exception (REC-1/REC-2, locked 2026-07-11): the reschedule write
orchestration is extracted into a single shared service and the customer-account
reschedule route is refactored onto it (see §5), so merchant and customer writes
cannot drift.

---

## 0. What changes vs. what is frozen

| Layer | Today | V2 | Change? |
| --- | --- | --- | --- |
| Render tree (`app.orders.tsx` JSX) | Polaris **web components** (`s-page`/`s-table`/`s-menu`/`s-modal`) | Polaris **React** (`Page`/`IndexTable`/`IndexFilters`/`Modal`) | **REWRITE** |
| Order detail panel | custom CSS `.ods-drawer` div | Polaris-native side panel (React) | **REWRITE** |
| `orders-dashboard.css` | ~hand-rolled design system | mostly deleted; Polaris tokens instead | **SHRINK** |
| `loader` + `GET_ORDERS_QUERY` | Admin GraphQL, server-side filters | unchanged (extended with a few read fields) | **PRESERVE (+additive)** |
| `action` handler + all mutations | archive/unarchive/cancel/tags/markFulfilled | unchanged + **new `reschedule` op** | **PRESERVE (+additive)** |
| `order-utils.ts` types + formatters | shared list/drawer helpers | unchanged | **PRESERVE** |
| `useBulkActions.ts` | fetcher + toast + modal show/hide | reworked to Polaris `Modal` open state (no `getElementById`) | **REWORK (behavior-preserving)** |
| Services (`order-delivery-metafields`, `delivery-availability`, `schedule-rules`) | canonical write/validation | unchanged | **PRESERVE** |
| Reschedule write orchestration | inlined in `public.customer-account.reschedule.ts` (does NOT use the shared services; does NOT write legacy mirrors) | extracted to shared `rescheduleOrderDelivery()` service; customer route refactored onto it | **EXTRACT (REC-1/REC-2)** |

**Non-negotiable preservation list** (verified against api.md §2 write-path contract):
`custom.date`, `custom.time_slot`, `delivery.date`, `delivery.time_slot`,
`sidekick.delivery_date`, `$app.reschedule_status`, `$app.reschedule_requested_at`,
`delivery.reschedule_history`, the `Delivery Date`/`Delivery Time` customAttributes,
the `resched` lock tag (`RESCHEDULED_ORDER_TAG`), and `custom.bouquet_photo`.

---

## 1. Package + provider prerequisite

- **Dependency installed (Phase 0 shipped 2026-07-11):** `@shopify/polaris@^13.9.5`
  (React) is now in `package.json` alongside the pre-existing
  `@shopify/polaris-types` (types for the web components). `AppProvider` from
  `@shopify/shopify-app-react-router/react` (App Bridge) is already in `app.jsx`.
- **Provider nesting** (done, `app/routes/app.jsx`): Polaris `AppProvider` (with
  `i18n`) nests **inside** the App Bridge `AppProvider`, wrapping `<Outlet/>`.
  Polaris CSS imported once via a `links()` export
  (`@shopify/polaris/build/esm/styles.css?url`).
- App Bridge (`useAppBridge`, `shopify.toast`) stays — Polaris and App Bridge
  coexist; toasts keep firing through App Bridge.

```
AppBridge AppProvider (embedded, apiKey)   ← existing
  └─ ui-nav-menu                            ← existing
  └─ Polaris AppProvider (i18n)             ← NEW
       └─ Outlet → /app/orders (Polaris React tree)
```

---

## 2. Page hierarchy

```
Page  (title "Orders Operations", fullWidth)
├─ (optional) KPI band — 5 cards: Orders · Revenue · Unpaid · Unfulfilled · Delivery fees
│     (kept from today; re-skinned as Polaris; clickable Unpaid/Unfulfilled → tab;
│      cards carry an explicit "this page" scope label — values are computed from
│      the loaded page only, not the whole filtered set — REC-8, locked)
├─ Card
│  ├─ IndexFilters              ← saved views (tabs) + search + filters + sort
│  │    ├─ Tabs (saved views): All · Today · Tomorrow · This week · Unfulfilled · Unpaid
│  │    ├─ Search field         (order, customer, phone, city)
│  │    └─ Filters: Delivery date · Time slot   (+ applied-filter pills)
│  └─ IndexTable                ← selectable rows + bulk actions + pagination
│       ├─ promotedBulkActions  (Mark fulfilled · Update delivery slot · Add/Remove tags)
│       ├─ bulkActions          (Reschedule · Archive · Unarchive · Cancel)
│       └─ IndexTable.Row × N
└─ OrderDetailsPanel            ← opens on row click via `?order=` URL param (REC-7);
                                   native side-panel styling
```

**Interaction-model parity with native Shopify Orders:**
- **Saved views** = Polaris `IndexFilters` tabs; the existing `?tab=` URL contract
  is kept (each tab maps to the same Shopify query fragment the loader already builds).
- **Sorting** — `IndexTable` `sortable` columns; wire to the existing
  `sortKey: CREATED_AT` (extend loader to accept a `sort` param for delivery-date sort).
- **Row selection / bulk bar** — `useIndexResourceState` replaces the manual
  `selectedIds` Set. (`selectedIds`→`selectedResources` is a mechanical swap.)
- **Pagination** — `IndexTable` `pagination` prop wired to the existing cursor
  handlers (`handleNextPage`/`handlePreviousPage`, the UX-01 fix — unchanged).
- **Responsive** — `IndexTable` `condensed` at small breakpoints (native behavior).

---

## 3. Table layout (columns)

Same columns as today, mapped to `IndexTable` headings. `first` column = selection
(built into IndexTable). New fields requested by the merchant are added.

| # | Heading | Source (existing helper) | Notes |
| --- | --- | --- | --- |
| 1 | Order | `order.name` + `createdAt` | subdued date under name; **"anong petsa/oras bumili"** = `createdAt` |
| 2 | Items | `lineItems` thumbnail + count | click → panel |
| 3 | Customer | `getCustomerName` + email | |
| 4 | City | `getCity` | |
| 5 | Delivery date | `getDeliveryDateValue` + `getDeliveryRelativeLabel` | Today/Overdue `Badge` |
| 6 | Time window | `getDeliveryTimeValue` | |
| 7 | Payment | `financialStatusTone` | Polaris `Badge` |
| 8 | Fulfillment | `fulfillmentStatusTone` | Polaris `Badge` |
| 9 | Total | `formatMoney` | numeric-aligned |
| 10 | Tags | `getMeaningfulTags` | overflow → `+N` |

Row click anywhere (except the checkbox) opens the panel — `onClick` on the Row,
guarded so the selection checkbox still toggles selection.

---

## 4. Order details side panel (first-class delivery)

Replaces `OrderDrawer.tsx`. **Auto-closes any open bulk modal when it opens**, and
does not navigate to another page. **The open order is URL-driven** (`?order=<id>`
search param — REC-7, locked; replaces the old state-only `selectedOrderId`
pattern): the panel deep-links, survives a full page refresh, and its open state is
preserved across `useRevalidator` refreshes for free because the URL is the source
of truth. The panel reads the fresh loader object by ID — no separate fetch.
Rendered as a right-aligned Polaris
panel (custom `Frame`-less overlay styled with Polaris tokens; or `Modal` `large`
right-docked — decided at build time, but visually a Shopify side panel).

### Information hierarchy (top → bottom)

1. **Header** — order name, financial + fulfillment `Badge`s, customer name +
   order count, total. **Actions menu** (top-right): Reschedule · Edit delivery
   details · Send email · View order status page · Open in Shopify Admin.
2. **DELIVERY** (first-class section)
   - Delivery date (+ Today/Overdue badge)
   - Delivery time slot
   - **Delivery status** (derived: Scheduled / Rescheduled / Fulfilled — from
     `$app.reschedule_status` + `displayFulfillmentStatus`)
   - **Fulfillment status** (`displayFulfillmentStatus`)
   - **Payment status** (`displayFinancialStatus`)
   - Address, city, province (copyable)
   - Card message, instructions (copyable) — `getInstructionValue`
   - **Sender phone number** — `getOrderPhone` (already exists; newly surfaced)
   - **Customer notes** — `order.note` / instruction attrs
3. **DELIVERY TIMELINE** (when reschedule history or `resched` tag present)
   Timeline events rendered from `getRescheduleTimelineEvents(order)`:
   - **Original schedule** — `Delivery Date`/`Delivery Time` customAttributes
   - **Requested schedule** — each history event's `fromDate/fromTimeSlot → toDate/toTimeSlot`
   - **Approved / current schedule** — `custom.date`/`custom.time_slot` +
     `$app.reschedule_status`
   - Each event: timestamp (`requestedAt`), source (customer/merchant), status.
   - **This is the merchant's at-a-glance signal that a customer requested or
     completed a reschedule** — surfaced as a Polaris timeline/`Badge` list.
4. **ITEMS** — line items + Subtotal / **Shipping fee** (`totalShippingPriceSet`) /
   Total. Shipping fee is the requested "shipping fee" field (already loaded).
5. **ORDER HISTORY / ORDER TIMELINE** — reschedule history events (above) plus
   created-at; "View order status page" + "Order history" deep links to Shopify.
6. **TAGS** — chips + add-tag form (same single write, `tagsAdd` to route action).

### Panel action buttons (requested additions), and their write path

| Action | Mechanism | Write path |
| --- | --- | --- |
| Reschedule order | opens Reschedule modal (see §5) | **NEW route action op** |
| Edit delivery details | same Reschedule modal (date/slot) | **NEW route action op** |
| Send email | `shopify://admin/orders/{id}` email, or `mailto:` | no delivery write |
| Sender phone number | display only (`getOrderPhone`) | read |
| View order status page | order `statusPageUrl` (add to query) | read |
| Order history / timeline | reschedule history + Shopify deep link | read |
| Open in Shopify Admin | `shopify://admin/orders/{id}` | read |

---

## 5. Reschedule / edit-delivery flow (merchant = ADMINISTRATIVE OVERRIDE)

**Scope framing (merchant policy, locked 2026-07-11):** the merchant manual
reschedule is an **administrative override**. Delivery scheduling authority
ultimately belongs to the merchant. The Customer Account self-service restrictions
(`resched` lock, `≥2-days` gate, `FULFILLED`/`IN_PROGRESS` gate, cutoff/prep date
window) are **customer-flow-only policy** and never bind the merchant path — the
merchant can reschedule an order even if it is already fulfilled, past the normal
cutoff, outside the customer reschedule window, or past the self-service period.
What DOES bind the merchant path is **data integrity**: validations that prevent
invalid or corrupted delivery state are preserved.

Structural consequence: `/app/orders` becomes the **4th delivery write path**
(today it is explicitly *not* one, per api.md §2 caveat) — recorded in
decisions.md ADR-10, with the api.md §2 table updated when Phase 4 ships.

### Governing principle — separate the DATA from the self-service CONTROL

1. **Delivery-schedule DATA (canonical state)** — `custom.date`,
   `custom.time_slot`, `delivery.*`, `sidekick.*`, the `Delivery Date`/`Delivery
   Time` customAttributes, the date + slot schedule tags,
   `delivery.reschedule_history`, and `$app.reschedule_status`. **The merchant and
   the customer both write this, via the same shared service (below).**
2. **Customer self-service CONTROL** — the `resched` lock tag, the `≥2-days`
   gate (`canRescheduleDelivery`), the `FULFILLED`/`IN_PROGRESS` gate, and the
   cutoff/prep/`maxDays` date window. **Customer-flow-only policy; the merchant
   path skips all of it.**

### Validation matrix for the merchant path (locked 2026-07-11)

| Check | Class | Merchant path behavior |
| --- | --- | --- |
| Date format (`YYYY-MM-DD` validity), slot exists in the configured slots | data integrity | **Hard-enforced** |
| Blocked date / blocked slot (`disabledDates` / `disabledSlots`) | data integrity | **Hard-enforced** |
| Slot capacity (`booked >= capacity`) | merchant ops policy | **Warn + explicit confirm override** (REC-4) — the confirm dialog shows the resulting load (e.g. "23/20"); the merchant is the final authority on their own capacity |
| Cutoff / prep-hours minimum date, `maxDays` window | customer sales policy | **Skipped** (REC-3) |
| `resched` lock, `≥2-days` gate, `FULFILLED`/`IN_PROGRESS` gate | customer self-service control | **Skipped** |

**Engine note (REC-3):** `validateDeliverySelection` bundles the date-window policy
(cutoff/prep `minDate`, `maxDays`) together with the data-integrity checks, so the
merchant path uses a **merchant-mode validation** — decomposed checks (format +
slot-exists + blocked + capacity-with-override) — instead of the storefront-facing
function as-is. The engine itself is **not modified** for the storefront / customer
/ webhook paths: zero behavior change outside the merchant path. Per the locked
policy: any future change to a data-integrity validation requires documented
reasoning + impact analysis in this doc set **before** implementation.

**Known accepted impact of skipping the date window:** the merchant can schedule
deliveries for dates the storefront would refuse (e.g. same-day inside the prep
window, or beyond `maxDays`). Booked counts still derive from schedule tags, so
such orders still count against the slot's capacity everywhere.

### Design: ONE shared write orchestration (REC-1, locked)

A new server service **`rescheduleOrderDelivery()`**
(`app/services/reschedule-order-delivery.server.ts`) becomes the single place that
defines the delivery reschedule write sequence. Both callers use it:

- **Customer route** (`public.customer-account.reschedule.ts`) — **refactored** to
  call the shared service after its self-service gates pass. (Today the route
  inlines every mutation and does NOT go through the shared services — the review
  found its metafield set also differs, see mirrors note below. That inline
  orchestration moves into the service.)
- **Merchant op** — a new `reschedule` op in the **existing** `app.orders.tsx`
  `action` handler (not a new route), running under `authenticate.admin` (session
  auth, no JWT), calling the same service with `source: "merchant"`.

The service's write sequence (defined once, same shape for both sources):

1. `metafieldsSet` — `custom.date`, `custom.time_slot`, **plus the legacy mirrors
   `delivery.date`, `delivery.time_slot`, `sidekick.delivery_date`** (REC-2,
   locked: both sources write the identical metafield set. Previously the customer
   route left the mirrors stale after a reschedule — this refactor fixes that
   inconsistency), plus `$app.reschedule_status` = `confirmed` and
   `$app.reschedule_requested_at`.
2. Append to `delivery.reschedule_history` (`RescheduleHistoryEvent`, `source:
   "customer" | "merchant"`).
3. `orderUpdate(customAttributes)` — `Delivery Date` / `Delivery Time`.
4. Schedule tags — remove prior delivery tags, add new date + slot label,
   **plus `resched` ONLY when `source: "customer"`**.
5. Per-step sync-state reporting (same `syncStates` shape the customer route
   returns today).

### What the merchant path deliberately does NOT do

- **Does NOT add the `resched` lock tag.** That tag is the customer self-service
  lock. A merchant updating the schedule is not the customer consuming their one
  online reschedule, so the customer keeps their remaining self-service window.
  **Confirmed live + accepted by the merchant (2026-07-12, Phase 4 smoke test):
  after a merchant reschedule, a still-eligible customer CAN reschedule once
  more.** This is conscious behavior, not a regression — in normal operation
  the ≥2-days rule or fulfillment closes the customer window anyway, so the
  residual risk is low. Do not "fix" this without a new decision.
- **Does NOT enforce any self-service gate or the date window** — see the
  validation matrix above.

### Explicitly DECLINED hardening (REC-5 = No, 2026-07-11 — recorded so it is not re-litigated)

The following were proposed during the principal-architecture review and
**declined** by the merchant. Their absence is a conscious decision; the risks are
accepted:

- **No pre-write race-guard recheck** on the merchant op (the customer route keeps
  its own existing `RECHECK_ORDER_STATE_QUERY` behavior).
- **No re-read of `reschedule_history` immediately before append** — a concurrent
  customer + merchant reschedule can lose one history event (accepted risk;
  `delivery.reschedule_history` is the only persistent audit trail).
- **No staff actor identity** (email/ID) on history events — `source: "merchant"`
  is the only attribution granularity.
- **No confirmation dialog for FULFILLED/IN_PROGRESS orders** — the
  capacity-override confirm (REC-4) is the only friction in the flow.

### Bulk "Update delivery slot" (one date/slot for N selected orders)

- **Upfront capacity computation** for the target slot: if moving `N` orders would
  exceed remaining capacity, the confirm dialog shows the resulting overload
  ("23/20") and requires explicit confirm — same warn+override policy as single
  (REC-4). Orders already sitting in the target slot are not double-counted.
- Writes run per order (continue-on-error); per-order success/failure is reported
  through the existing bulk toast partial-failure pattern.

### Integration with the existing customer-account reschedule

- **Single source of truth structurally guaranteed** — one service defines the
  write contract, so merchant- and customer-sourced writes cannot drift; the
  timeline, admin block, thank-you, and customer-account surfaces all read one
  consistent delivery state.
- The timeline (`§4.3`) shows customer- and merchant-sourced events together,
  distinguished by the `source` field already in `RescheduleHistoryEvent`.

---

## 6. Smart auto-refresh & data freshness

The loader already sends `Cache-Control: no-store`, and React Router re-runs the
loader on any navigation. V2 adds **client-driven revalidation** on top, using
React Router's `useRevalidator()` (re-runs the loader without a full navigation, so
URL state — filters, sort, tab, cursors — is preserved automatically). All refresh
logic lives in a new hook `useSmartRefresh`; no loader/action change is needed.

### Cadence

| Condition | Interval |
| --- | --- |
| Default (any view) | **30 minutes** |
| `Today` tab (and any same-day delivery view) | **5 minutes** |
| After any successful action (bulk or single) | **immediate revalidate** |
| After fulfillment-type actions (mark fulfilled) | immediate revalidate **+ one delayed re-poll ~3s later** (REC-6) |

**Why the delayed re-poll (REC-6, locked):** Shopify processes `fulfillmentCreate`
asynchronously, so a single immediate re-query can still read a stale
`displayFulfillmentStatus` — React Router's default already revalidates loaders
after a `fetcher.submit` action, yet the badge was observed stale (audit S3,
downgraded to repro-needed). The delayed re-poll covers Shopify's
eventual-consistency window.

### Pause rules — never refresh while the merchant is mid-task

Auto-refresh (both the interval tick and any queued tick) is **suppressed** when
any of these is true:

- an order details panel is open **and** being edited (a reschedule/edit-delivery
  form is dirty),
- any modal is open (cancel / mark-fulfilled / add/remove tags / reschedule),
- a bulk action or single action is in flight (`fetcher.state !== "idle"`),
- the browser tab is hidden (`document.visibilityState === "hidden"`) — resume on
  focus.

A read-only open panel (viewing, not editing) does **not** block refresh, but see
state-preservation below — the panel stays open and re-reads fresh data by ID.

### State preserved across a refresh

A revalidation must feel invisible. Preserved:

- **Filters / search / sort / tab / pagination cursors** — all URL-driven, so
  `useRevalidator` keeps them for free (no navigation).
- **Selected rows** — held in `useIndexResourceState`; after refresh, prune any
  selected ID that is no longer in the returned set (existing `useFilteredSelection`
  behavior, kept).
- **Open order details panel** — URL-driven via the `?order=` search param
  (REC-7, see §4), so it survives revalidation for free; the panel re-derives its
  order from the fresh loader array by ID and stays open with updated data. If that
  order dropped out of the result set, keep the panel open on the last-known
  snapshot and show a subtle "no longer in this view" note rather than yanking it
  shut.

### "Last updated" indicator + new-data notification

- **"Last updated HH:MM"** (relative, e.g. "Updated 2 min ago") shown near the
  table toolbar; timestamp set on each successful loader settle.
- **New-orders / schedule-change nudge** — after a background revalidate, diff the
  new order-id set (and delivery-date/status per id) against the previous snapshot;
  if new orders appeared or delivery schedules changed, show a small dismissible
  `Banner`/`Badge` ("3 new orders" / "schedule updates") instead of silently
  reflowing the table. Clicking it scrolls to / highlights the changes. The diff is
  client-side off already-loaded data — no extra query.

### Files

```
app/hooks/useSmartRefresh.ts     [NEW]  interval + visibility + pause + revalidate
app/hooks/useOrdersDiff.ts       [NEW]  prev/next snapshot diff → new-order nudge
```

Both are presentation-only; they call `useRevalidator().revalidate()` and read
`fetcher.state` / panel / modal open state. No business-logic or loader changes.

---

## 7. Component tree (files)

```
app/routes/app.jsx                         [EDIT]  nest Polaris AppProvider + import CSS
app/routes/app.orders.tsx                  [EDIT]  loader (+sort/statusPageUrl fields),
                                                    action (+"reschedule" op), Extension()
                                                    render → Polaris React
app/components/orders/
  OrdersIndexTable.tsx                      [NEW]   IndexFilters + IndexTable + rows
  OrderDetailsPanel.tsx                     [NEW]   replaces OrderDrawer.tsx
  panel/DeliverySection.tsx                 [NEW]
  panel/DeliveryTimeline.tsx               [NEW]   from getRescheduleTimelineEvents
  panel/ItemsSection.tsx                    [NEW]
  RescheduleModal.tsx                        [NEW]   date + slot picker (uses schedule rules)
  CancelModal / ArchiveModal / …            [EDIT]  s-modal → Polaris Modal
  MarkFulfilledModal.tsx                     [EDIT]  s-modal → Polaris Modal
app/components/OrderDrawer.tsx              [DELETE] superseded by OrderDetailsPanel
app/hooks/useBulkActions.ts                 [EDIT]  Set→useIndexResourceState; Modal open state
app/hooks/useCopyToClipboard.ts             [KEEP]
app/lib/order-utils.ts                      [KEEP]  (+ maybe getDeliveryStatus derive helper)
app/services/reschedule-order-delivery.server.ts   [NEW]  shared reschedule write
                                                    orchestration (§5, REC-1) — used by
                                                    BOTH the customer route and merchant op
app/routes/public.customer-account.reschedule.ts    [EDIT Phase 4] refactor onto the
                                                    shared service (gates stay in-route)
app/services/order-delivery-metafields.server.ts   [KEEP] building blocks consumed by the shared service
app/lib/delivery-availability.ts            [KEEP] engine unchanged; merchant path uses
                                            decomposed merchant-mode checks (§5 matrix)
app/styles/orders-dashboard.css             [SHRINK Phase 1: prune --p-* token overrides (REC-10) / DELETE rest Phase 5]
```

---

## 8. Build sequence (phased, each independently shippable)

- **Phase A — Audit baseline (no code changes).** Complete the
  [smoke-test issue audit](./orders-ops-v2-audit.md): reproduce each reported issue,
  find root cause, document it. Fixes land in the phase where that surface is
  rewritten (most are presentation bugs that the rewrite resolves; any that turn out
  to be business-logic bugs are flagged for a separate, explicitly-approved change).
- **Phase 0 — DONE 2026-07-11** — Installed `@shopify/polaris`; nested provider in
  `app.jsx`; imported CSS. Existing page still boots (web-component page
  unaffected; typecheck + build verified).
- **Phase 1 — DONE 2026-07-11, live-verified same day** (full smoke checklist
  passed against the working tree served through the new separate dev app
  `delivery-scheduler-DEV` on `flowercart-dev` — `?order=` appears in the admin
  URL and the panel survives a browser refresh; **REC-7 verified & closed**.
  The two earlier smoke-test "failures" were stale-deployed-build artifacts;
  see the three 2026-07-11 smoke-test verification-log rows. Panel navigation
  uses **push** — kept for UX: Back closes the panel) — `OrderDetailsPanel`
  (custom Polaris-token overlay), read-only, swapped for `OrderDrawer`, opened
  via the `?order=` URL param (REC-7; plus a `shouldRevalidate` that skips the
  loader re-run when only `?order` toggles). Delivery-first layout + timeline + all requested display
  fields (sender phone, buy date/time, shipping fee, order history). No write
  changes (the panel's tag-add form posts the same existing `tagsAdd` op the
  drawer did). Loader gained two read fields: `statusPageUrl` +
  `$app.reschedule_status` (MCP-validated, no new scopes). **Also pruned the
  `--p-*` Polaris token overrides from `orders-dashboard.css` (REC-10)** — the
  `var(--p-*, fallback)` consumers stay; rest of the file cleanup stays in
  Phase 5. `OrderDrawer.tsx` remains on disk (unmounted) until Phase 5.
- **Phase 2 — DONE 2026-07-11, live-verified same day** (full merchant smoke
  checklist passed on the dev app after the round-2 fixes — tabs, filters,
  sort, search, bulk actions, panel refresh persistence all ✅; audit
  S1/S2/S4/S5/S6 + E1/E2 closed) —
  Table → `IndexFilters` + `IndexTable` (new
  `app/components/orders/OrdersIndexTable.tsx`); `useIndexResourceState` replaces
  the manual `selectedIds` Set; tabs/search/filters/pagination all keep the same
  URL params; bulk bar = IndexTable `promotedBulkActions`
  (Mark as fulfilled · Add tags · Remove tags) + `bulkActions`
  (Archive · Unarchive · Cancel). All eight modals → Polaris `Modal` with React
  open state in `useBulkActions` (`activeModal`) — **fixes the
  presentation-layer smoke-test issues S1/S2/S5/S6 + B1/B2** (auto-close on
  success, toast visible, single trigger pattern). Remove-tags modal gained
  clickable suggestions from the selected orders' tags (audit S4, client-side
  only). KPI band re-skinned as Polaris Cards with the "· this page" scope label
  (REC-8). New `sort` URL param + `$reverse` query variable (MCP-validated, no
  new scopes): Order date asc/desc is server-side; Delivery date asc/desc is
  client-side on the loaded page (the Admin API has no metafield sort key —
  documented deviation from the §2 parenthetical). Deleted dead
  `app/lib/get-safe-event-value.ts` (audit C3, zero importers after the
  rewrite). "Update delivery slot"/"Reschedule" bulk actions arrive at Phase 4.
  **No write-path change** — the action handler, mutations, and loader contract
  are untouched apart from the additive `sort`/`reverse` read behavior.
  **Round-2 fixes (same day, after the merchant smoke test; re-test PASSED
  same day):** all delivery-date/time-slot filtering (Today/Tomorrow
  tabs + both toolbar filters) moved **client-side** — Shopify silently
  ignores metafield search terms on orders (audit E1; they never filtered,
  even in production); view tabs moved out of IndexFilters into a plain
  deterministic button row + `disableStickyMode` (audit E2 — the Polaris Tabs
  collapse behind the reported "phantom tab=unpaid" and the panel-refresh
  failure); date filter commits only complete sane dates; search ✕ clears
  immediately.
- **Phase 3 — DONE, live-verified 2026-07-11 (merchant smoke test PASSED on the
  dev app; closes audit S3 — the mark-fulfilled badge settled via the delayed
  re-poll)** —
  `useSmartRefresh` (30-min default / 5-min Today cadence via `useRevalidator`;
  ticks queued while any modal is open, an action fetcher is in flight, or the
  tab is hidden, and fired when the blocker lifts; any loader settle resets the
  stamp and drops the queued tick) + `useOrdersDiff` (per-view snapshot diff →
  dismissible "N new orders · M schedule updates" banner + New/Updated row
  badges) + "Last updated" indicator with a manual plain Refresh button above
  the table. REC-6 delayed re-poll (~3s) after successful mark-fulfilled lives
  in `useBulkActions`. The `?order=` panel now keeps a last-known snapshot with
  a subtle "no longer in this view" note when a background revalidate drops the
  order out of the loaded set (§6). Presentation-only — no loader/action/
  write-path change. Note: panel dirty-form pause tracking is deferred to the
  Phase 4 reschedule form (today's panel only has the tag form, whose local
  input state survives a revalidate). The smoke test also surfaced a
  **pre-existing panel display bug** (not Phase 3 code): the timeline's
  "Original schedule" row derives from order `customAttributes`, but the
  reschedule write path overwrites those as a legacy mirror — so after any
  reschedule "Original" always duplicates Current. Fix (derive original from
  the **oldest history event's `from`** when history exists) ships with
  Phase 4.
- **Phase 4 — DONE, live-verified 2026-07-12 (merchant smoke test PASSED on the
  dev app: single + bulk reschedule, capacity override, blocked date/slot
  rejection, customer-regression incl. mirror metafields, timeline
  source-badged events + corrected Original row)** —
  New shared service `app/services/reschedule-order-delivery.server.ts`
  (`rescheduleOrderDelivery()`, REC-1): ONE write sequence — canonical
  `metafieldsSet` (`custom.*` + the `delivery.*`/`sidekick.*` legacy mirrors,
  REC-2, + `$app.reschedule_*`) → `reschedule_history` append (`source`
  recorded) → customAttributes mirror → schedule-tag replacement (`resched`
  added ONLY for `source: "customer"`). Customer route refactored onto it
  (all self-service gates + `RECHECK_ORDER_STATE_QUERY` kept in the route;
  response shape unchanged; behavior delta: mirrors now written, and a mirror
  step that throws now reports `"failed"` instead of aborting the request).
  Merchant `reschedule` op added to the `app.orders.tsx` action (§5
  administrative override): `validateMerchantRescheduleSelection` (additive
  in delivery-availability.ts) hard-enforces date format / slot-exists /
  blocked date / blocked slot only; capacity = warn + explicit confirm
  override (REC-4 — server responds `capacity_override_required` with the
  projected load unless `capacityOverride=1`; orders already in the target
  slot are not double-counted); per-order continue-on-error writes. UI: new
  `RescheduleModal` (bulk "Update delivery slot" promoted action + the
  panel's actions-menu item for single orders; prefills a single target's
  current schedule; shows per-slot booked/capacity; overload flips the
  primary button to a destructive "Reschedule anyway (N/M)"); rules load
  lazily from the new read-only resource route
  `/app/orders/reschedule-rules`. Also fixed the **timeline "Original
  schedule" display bug** found in the Phase 3 smoke test: it now derives
  from the oldest history event's `from` (attributes remain the fallback for
  history-less orders). Unit tests: 13 new (service write-sequence/parity +
  merchant validation matrix). NO new scopes (GraphQL MCP-validated:
  read_orders/write_orders already held) — stop-and-ask gate not triggered.
- **Phase 5** — Delete `OrderDrawer.tsx` + prune the rest of
  `orders-dashboard.css`; docs sync.

**Global build rules (locked 2026-07-11):**

- **Stop-and-ask gate:** if ANY phase turns out to need new Shopify scopes, auth
  changes, API credentials, environment variables, an app reinstall, Cloud Run
  changes, Partner Dashboard changes, or any other action only the merchant can
  perform — **STOP**. Do not proceed as if the requirement is available. State
  exactly what is needed and why, give step-by-step instructions for the merchant
  to do it, and wait for confirmation before continuing.
- **Docs-first:** this doc set reflects the final design before each phase's code
  lands (per the CLAUDE.md read-first / update-after loop).

---

## 9. Docs to update on ship (per CLAUDE.md loop)

- `docs/api.md` §2 — add the **4th delivery write path** (merchant reschedule) to
  the write-paths table; remove the "/app/orders is not a delivery write path"
  caveat; **update the Customer Account reschedule row** — after the Phase 4
  refactor it also writes the legacy mirrors (`delivery.*`,
  `sidekick.delivery_date`) via the shared service (REC-2).
- `docs/architecture.md` — system diagram: `/app/orders` becomes a write surface.
- `docs/orders-ui.md` — mark presentation half superseded by this doc.
- `docs/decisions.md` — **new ADR**: "Merchant manual reschedule reuses the customer
  delivery write contract; skips the customer self-service control layer (resched
  lock + gates)." + "Adopt Polaris React for /app/orders."
- `docs/known-issues.md` — reconcile with the audit findings.
- `docs/verification-log.md` + `docs/changelog.md` — dated entries.

## 10. Decisions — all locked (2026-07-11)

- **`resched` tag on merchant reschedule → NOT added.** The `resched` tag is a
  customer self-service lock, not delivery-schedule data (see §5 governing
  principle). Merchant path skips it and the `≥2-days` / `FULFILLED` self-service
  gates; it enforces only `validateDeliverySelection` (data correctness).
- **Side panel → custom Polaris-token overlay** (not Polaris `Modal`). Chosen
  because it stays closer to the Shopify Admin experience and keeps the order table
  visible behind the panel while viewing/editing an order — the table never
  disappears. Built with Polaris design tokens + primitives (`Text`, `Badge`,
  `BlockStack`, `InlineStack`, `Button`), backdrop + `Esc`/click-out close, right-
  docked. (Polaris has no first-class Drawer, so this is a thin overlay, not a
  hand-rolled design system — it consumes Polaris tokens/components.)
- **KPI band → kept and modernized.** The merchant uses it as a quick operations
  overview, so it stays. Re-skinned to match native Shopify Admin (Polaris `Card`
  + `Text` tokens, subdued labels, `BlockStack`/`InlineGrid`), clickable
  Unpaid/Unfulfilled → tab, same client-side `useMemo` computations — with an
  explicit **"this page" scope label** (REC-8, see §10a).

## 10a. Decisions — second batch, all locked (2026-07-11, post principal-architecture review)

Outcome of the yes/no approval round on the architecture review's recommendations:

- **Merchant reschedule = administrative override** — the merchant's policy
  statement is recorded verbatim-in-substance in §5: customer restrictions bind
  only the Customer Account self-service; data-integrity validations are
  preserved; any data-integrity validation change needs documented reasoning +
  impact first.
- **REC-1 YES** — one shared `rescheduleOrderDelivery()` service defines the write
  sequence; the customer route is refactored onto it (Phase 4).
- **REC-2 YES** — both reschedule sources write the legacy mirror metafields;
  fixes the current customer-path stale-mirror inconsistency.
- **REC-3 YES** — merchant path skips the cutoff/prep/`maxDays` date window via
  merchant-mode validation (§5 matrix); engine unchanged for all other paths.
- **REC-4 WARN + OVERRIDE** — slot capacity is merchant ops policy, not a hard
  block: overload warning + explicit confirm, single and bulk.
- **REC-5 NO (declined)** — no race-guard recheck, no history re-read before
  append, no staff actor identity, no fulfilled-order confirm dialog on the
  merchant op. Risks recorded and accepted (§5).
- **REC-6 YES** — audit S3 downgraded to repro-needed; §6 gains a ~3s delayed
  re-poll after fulfillment-type actions (Shopify eventual-consistency
  hypothesis).
- **REC-7 YES** — order details panel is URL-driven (`?order=` search param):
  deep-linkable, refresh-safe, revalidation-safe. **Verified live 2026-07-11**
  on the dev app (`?order=` syncs to the admin address bar; panel survives
  refresh).
- **REC-8 YES** — KPI cards carry a "this page" scope label (values are computed
  from the loaded page only, not the whole filtered set).
- **REC-9 YES** — ADR-9 records that adopting Polaris React is a conscious bet
  against Shopify's web-components direction, with the exit cost bounded by the
  frozen loader/services.
- **REC-10 YES** — the `--p-*` token-override pruning moves from Phase 5 to
  Phase 1.
- **Smart auto-refresh (§6) confirmed as specced** — 30-min default / 5-min Today
  & same-day views; paused during open modal, ongoing edit, or in-flight action;
  post-success refresh preserves filters, sorting, pagination, selected rows, and
  the open panel; "Last updated" indicator + new-orders/schedule-change nudge.
- **Stop-and-ask gate + docs-first rule** added as global build rules (§8).
