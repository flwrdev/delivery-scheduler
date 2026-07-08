# Order Operations Dashboard — Refactor vs Rebuild Audit

> **Session type:** READ-ONLY audit, 2026-07-08. No tracked file was modified; this
> proposal is the only file created. Judged against the V2 scope: add write paths
> (reschedule via `custom.date`/`custom.time_slot`/`reschedule_history`, mark
> fulfilled, mark COD paid) + Today-first view + keyboard-driven flow, for a solo
> operator at ~10–25 orders/day growing to low hundreds/day.

---

## Executive summary

**Recommendation: (A) REFACTOR in place.** 64% of the code is reusable as-is, the
34% that needs rework is mechanical extraction (not untangling), and the single
hardest V2 feature — the reschedule write path — already exists as tested, shared
services in this same repo (`syncOrderDeliveryMetafields`, `validateDeliverySelection`).
A greenfield namespace would import those exact services while duplicating the
loader, query, table, and CSS for zero domain gain — and force a solo operator to
run two dashboards during the gap.

---

## Step 1 — Inventory (evidence)

### Line counts (total lines, `Get-Content .Count`)

| File | Lines |
| --- | ---: |
| `app/routes/app.orders.tsx` | 2,502 |
| `app/styles/orders-dashboard.css` | 1,046 |
| `app/lib/order-utils.ts` | 601 |
| `app/components/OrderDrawer.tsx` | 449 |
| `app/hooks/useCopyToClipboard.ts` | 35 |
| **Total** | **4,633** |

### Internal structure of `app.orders.tsx` (counted, not estimated)

| Block | Location | Size |
| --- | --- | ---: |
| Imports + `links` + `PageInfo` | `app.orders.tsx:1–49` | 49 |
| `GET_ORDERS_QUERY` | `app.orders.tsx:53–168` | 116 |
| Runtime safety helpers (`getSafeEventValue`, `isIsoDateParam`, `isHttpTrackingUrl`) | `app.orders.tsx:172–196` | 27 |
| `loader` (+ `LoaderData` type) | `app.orders.tsx:200–296` | 99 |
| 9 GraphQL mutation documents + `buildBatchFulfillmentQuery` + `scopeHint` + `uploadBouquetPhoto` | `app.orders.tsx:300–498` | 199 |
| Action types (`BulkActionName`, response shapes, limits) | `app.orders.tsx:500–537` | 38 |
| `action` handler (bulk-op multiplexer) | `app.orders.tsx:541–887` | 347 |
| `ActiveTab` type + `useFilteredSelection` hook | `app.orders.tsx:889–913` | 25 |
| `Extension()` component | `app.orders.tsx:917–2500` | **1,584** |

### Distinct concerns inside `Extension()` (counted)

- **19 `useState` hooks**: `app.orders.tsx:934, 939, 942, 946, 949, 953, 954` (page/filter/selection/drawer state) + `:1287–1290` (cancel modal) + `:1293–1294` (tag modals) + `:1297–1303` (fulfill modal, 6 hooks incl. photo file/preview/error).
- **1 `useRef`** (`:943`), **5 `useEffect`** (`:964, 969, 975, 992, 1393`) plus 1 more inside `useFilteredSelection` (`:905`).
- **8 `useMemo`**: `dateRefs :1003`, `filteredOrders :1119`, KPI revenue `:1146`, KPI unpaid `:1177`, KPI unfulfilled `:1198`, KPI products `:1214`, KPI delivery fees `:1239`, `tabCounts :1259`.
- **23 handler functions**: 5 `useCallback` (`:956, 958, 1030, 1323, 1361`) + 18 plain (`:1024, 1048, 1062, 1077, 1086, 1094, 1100, 1108, 1305, 1314, 1337, 1338, 1339, 1340, 1342, 1351, 1356, 1373`).
- **JSX sections (~17)**: 1 `s-menu` (`:1474`) + **8 `s-modal` instances** (cancel `:1513`, archive `:1584`, unarchive `:1621`, mark-fulfilled `:1657`, add-tags `:1760`, remove-tags `:1800`, KPI-products `:1842`, shared-tags `:1874`) + error banner (`:1895`) + KPI grid with 5 cards (`:1908`) + tabs (`:1992`) + selection bar (`:2011`) + toolbar (`:2055`) + table header (`:2120`) + table body/rows (`:2159`) + lazy drawer mount (`:2490`).
- Modal show/hide is done by **direct DOM poking** (`document.getElementById(...).show()/hide()` — `hideModal :1305`, `showModal :1314`, shared-tags effect `:992–1000`), a coupling point to note for any extraction.

### Other files

- **`OrderDrawer.tsx` (449)** — props-only presentational panel; one write path
  (`tagFetcher.Form` posting `_action=tagsAdd` to the same route action,
  `OrderDrawer.tsx:413–440`); Escape/backdrop close + body-scroll lock
  (`OrderDrawer.tsx:112–126`). Lazy-loaded (`app.orders.tsx:5–7`, `:2491`).
- **`order-utils.ts` (601)** — pure types + formatters. The `Order` interface
  (`order-utils.ts:64–89`) is the canonical shape loader → table → drawer.
  **Three exports are dead code**: `parseTimeWindowHour` (`:107`),
  `normalizeTimeSlot` (`:391`), `getSearchableOrderText` (`:409`) — grep over
  `app/` finds no importer for any of them (remnants of the removed client-side
  filter era; see drift finding D1).
- **`useCopyToClipboard.ts` (35)** — self-contained hook, drawer-only consumer.
- **`orders-dashboard.css` (1,046)** — namespaced `ods-*` classes, sectioned with
  header comments, mapped to design-system tokens (`orders-dashboard.css:5`).
- **Test coverage: effectively zero for this surface.** `test/` contains exactly
  one file (`test/verify-app-proxy.server.test.ts`) — nothing for `order-utils`,
  the route, or the drawer. `e2e/reschedule.spec.ts` covers the customer
  reschedule flow, not this dashboard.

### V2-relevant assets that already exist in this repo

- `markFulfilled` write path **already implemented** — batch fulfillment-order
  fetch + `fulfillmentCreate` per order (`app.orders.tsx:709–870`), including a
  bouquet-photo upload pipeline (`:434–498`, `:848–868`).
- A "Today" tab already exists server-side (`app.orders.tsx:248–250`); the default
  tab is `"all"` (`app.orders.tsx:225`). Today-FIRST is a one-line default change
  plus UX emphasis.
- Reschedule domain logic already lives here as shared services:
  `syncOrderDeliveryMetafields` (`app/services/order-delivery-metafields.server.ts:343`),
  `syncOrderDeliveryScheduleTag` (`:369`), `validateDeliverySelection`
  (`app/lib/delivery-availability.ts:603`), `RESCHEDULED_ORDER_TAG`
  (`app/lib/constants.ts:13`) — the same primitives used by the live customer
  reschedule route (api.md §2, rows at `docs/api.md:104–112`).

---

## Step 2 — Reusability scorecard

| Bucket | Piece | Evidence | Lines |
| --- | --- | --- | ---: |
| **KEEP AS-IS** | `order-utils.ts` types + live helpers | Pure functions, imported by both list (`app.orders.tsx:8–30`) and drawer (`OrderDrawer.tsx:4–32`); V2's metafield conventions (`custom.date`, `custom.time_slot`, `reschedule_history`) are already first-class in `getDeliveryDateValue :303`, `getDeliveryTimeValue :319`, `getRescheduleTimelineEvents :506` | 526 |
| **KEEP AS-IS** | `useCopyToClipboard.ts` | Self-contained, no route coupling | 35 |
| **KEEP AS-IS** | `orders-dashboard.css` | Namespaced `ods-*`, token-mapped (`orders-dashboard.css:5`); V2 table/drawer reuse it verbatim | 1,046 |
| **KEEP AS-IS** | `OrderDrawer.tsx` | Props-only, no fetch of its own (`docs/orders-ui.md §3–4` verified against code); V2 additions (reschedule button, mark-paid button) are additive edits, not restructuring | 449 |
| **KEEP AS-IS** | `app.orders.tsx` non-component code: `GET_ORDERS_QUERY` (`:53–168`), loader (`:200–296`), mutation docs + upload pipeline (`:300–498`), action types (`:500–537`), action handler (`:541–887`), helpers (`:172–196`, `:889–913`), imports (`:1–49`) | The action handler is a clean per-op multiplexer with a shared `runOne` error-collector (`:601–637`); adding `reschedule` and `markPaid` ops is additive — `markFulfilled` (`:709–870`) proves the pattern absorbs a complex multi-step op without touching other ops | 900 |
| **SALVAGE WITH REWORK** | `Extension()` (`app.orders.tsx:917–2500`) | Concerns survive; structure doesn't scale. Rework: extract 8 modals into components (JSX at `:1513–1892` survives nearly verbatim), extract KPI/tab-count `useMemo`s (`:1146–1278`) into a `useOrderKpis` hook, extract filter/URL handlers (`:1024–1114`) into a `useOrderFilters` hook, extract bulk-action state + toast effect (`:1283–1444`) into a `useBulkActions` hook. Why: 19 `useState` + 23 handlers + 8 modals in one 1,584-line function means every V2 feature (keyboard nav, reschedule modal, mark-paid) enlarges the same function; the DOM-poking `showModal`/`hideModal` (`:1305–1321`) must be re-verified per extraction | 1,584 |
| **REWRITE (delete)** | Dead exports in `order-utils.ts`: `parseTimeWindowHour :107–120`, `normalizeTimeSlot :391–405`, `getSearchableOrderText :409–433` | No importer anywhere in `app/` (grep verified); cheaper to delete than carry | 75 |
| **REWRITE** | (nothing else) | No piece met "cheaper to rebuild than untangle" — the tangle is *size*, not coupling: all communication is props + URL params + one fetcher; no context spaghetti, no cross-module hidden state | 0 |

**Split (of 4,633 total lines): KEEP AS-IS ≈ 2,956 (64%) · SALVAGE ≈ 1,584 (34%) · REWRITE/DELETE ≈ 75 (2%).**

---

## Step 3 — Cost comparison

| Dimension | (A) Refactor | (B) Greenfield namespace |
| --- | --- | --- |
| **Phase 1** | Extract 8 modals → components; extract `useBulkActions` (state `:1283–1303` + toast effect `:1393–1444`) — **M** | Scaffold new route; copy `GET_ORDERS_QUERY` + loader — **S** |
| **Phase 2** | Extract `useOrderKpis` + `useOrderFilters` hooks — **S** | Rebuild list/table UI + toolbar + tabs + KPI grid — **L** |
| **Phase 3** | Add `reschedule` + `markPaid` ops to action handler (reuse `syncOrderDeliveryMetafields`/`validateDeliverySelection`); reschedule modal + drawer buttons — **M** | Same write paths, same services — **M** |
| **Phase 4** | Today-first default (`app.orders.tsx:225` change) + keyboard-driven flow — **M** | Keyboard flow + Today-first view — **M** |
| **Phase 5** | — | Run both dashboards in parallel; cutover; delete old route — **S** (but see ongoing risk) |
| **Total** | **S + 3×M** | **2×S + 2×M + L** |
| Dashboard usable mid-flight? | **Yes** — each phase is independently shippable; modal/hook extraction is behavior-preserving | Old dashboard untouched (safe), but V2 unusable until Phase 2 completes — the longest single phase |
| What breaks mid-flight? | Modal extraction can break the DOM-id-based `show()`/`hide()` wiring (`:1305–1321`, `commandFor` attributes `:1482–1506`) — must re-verify per modal | Nothing breaks, but bugs fixed in the old dashboard during the build must be fixed twice |
| Regression risk to current behavior | **Medium, one-time per phase** — no unit tests exist for this surface (only `test/verify-app-proxy.server.test.ts`), so verification is manual; mitigated by small per-phase diffs | **Low for old code, high for new** — the rebuilt table must re-earn every fix already embedded (e.g. cancelled-orders KPI exclusion `:1220`, selection pruning `:901–913`, search debounce/back-nav sync `:969–990`, failed-only reselect `:1440`) |
| Duplication | None | Query, loader, table markup, toolbar, KPI logic, CSS wiring — duplicated until decommission |
| Ongoing vs one-time risks | Extraction risk is **one-time**; after Phase 2 the file shrinks to loader/action + composition | Dual-dashboard maintenance is **ongoing** until cutover; risk of the cutover never happening (solo operator, no forcing function) |

---

## Step 4 — Recommendation

### Pick: (A) Refactor

1. **The scorecard says most of the work is already done.** 64% keep-as-is, 2%
   delete, and the 34% salvage bucket is *mechanical* — the modal JSX
   (`app.orders.tsx:1513–1892`) and KPI memos (`:1146–1278`) move to new files
   nearly verbatim. Nothing met the "cheaper to rebuild" bar.
2. **Two of the three V2 write paths are already ~solved in place.**
   `markFulfilled` is fully implemented (`:709–870`) and proves the action
   handler's per-op pattern (`runOne`, `:601–637`) absorbs complex ops. The
   reschedule write path reuses `syncOrderDeliveryMetafields`
   (`order-delivery-metafields.server.ts:343`) and `validateDeliverySelection`
   (`delivery-availability.ts:603`) — services that live in *this* repo and would
   be imported identically by a greenfield route. Greenfield buys namespace
   isolation, not domain progress. Mark-COD-paid is one more `runOne` op
   (`orderMarkAsPaid` mutation).
3. **Solo-operator economics.** At 10–25 orders/day there is no parallel-team
   argument for a second dashboard, and dual maintenance is pure overhead. The
   growth target (low hundreds/day) does not change the architecture — the
   loader's cursor pagination (`:227–269`) and server-side filtering already
   handle it.
4. **Today-first is a default-value change** (`tabParam = ... ?? "all"`,
   `app.orders.tsx:225`) plus emphasis — near-zero cost in place, full-rebuild
   cost in greenfield.

### Steelman for (B) Greenfield — the strongest honest case

- `Extension()` is 1,584 lines with 19 state hooks, and **every** V2 feature
  makes it bigger before refactoring makes it smaller. With **zero unit tests**
  on this surface, each extraction phase is verified only by hand — a parallel
  build leaves the working dashboard frozen as a guaranteed fallback while V2
  stabilizes, which is the safest possible posture for a solo operator's only
  ops tool.
- A keyboard-driven, Today-first workspace is arguably a *different information
  architecture* (a work queue) than a filterable table; reusing the existing
  `s-table` markup could anchor V2's design to the wrong shape.
- Decommissioning is genuinely cheap here (delete one route file), so B's usual
  worst cost is smaller than typical.

### Flip conditions — when (B) wins instead

1. **If V2's UX is decided to be a queue/kanban, not a table** — then the table
   JSX (the biggest salvage item) stops being reusable and the split degrades to
   roughly 50% keep / 15% salvage / 35% rewrite, at which point greenfield wins.
2. **If Phase-1 extraction reveals the Polaris web-component modal wiring
   (`commandFor`/`command` attributes + `getElementById` show/hide) breaks when
   modals move to child components** and has no clean fix — the salvage bucket's
   "mechanical" premise fails.
3. **If the dashboard must stay bit-frozen during V2 development** (e.g. peak
   season freeze) — refactor-in-place violates the freeze by definition.

---

## Docs-vs-code drift findings

- **D1 — `docs/api.md:219–224` (§5 flowchart) is stale.** The `/app/orders` box
  claims "filters + sort (city, timeWindow, deliveryDate, fulfillment)" and
  "`DEFAULT_VISIBLE_COLUMNS` vs `MOBILE_VISIBLE_COLUMNS`". Neither exists:
  grep over `app/` finds no `DEFAULT_VISIBLE_COLUMNS`/`MOBILE_VISIBLE_COLUMNS`
  anywhere; the actual toolbar has search + delivery-date + time-slot + reset
  (`app.orders.tsx:2055–2116`) and URL tabs — no city filter, no sort control,
  no column-visibility system. Corroborated by the dead exports
  (`parseTimeWindowHour`, `normalizeTimeSlot`, `getSearchableOrderText` —
  `order-utils.ts:107, 391, 409`) left over from that older client-side-filter
  iteration.
- **D2 — `docs/api.md:116–123` (§2 caveat) mutation list is incomplete.** It
  lists `orderClose/orderOpen/orderCancel/tagsAdd/tagsRemove/fulfillmentCreate`
  but omits the bouquet-photo pipeline the same `action` runs:
  `stagedUploadsCreate` (`app.orders.tsx:389`), `fileCreate` (`:402`), and
  `orderUpdate` writing the **`custom.bouquet_photo` metafield** (`:415–422`,
  executed `:848–868`). The doc's core claim ("does not write delivery state")
  remains true — `bouquet_photo` is not a delivery field — but "mutates order
  state and freeform tags **only**" (`docs/architecture.md:210`) undersells what
  the handler writes.
- **D3 — `docs/orders-ui.md` (untracked, pre-existing) is accurate.** Spot-checked
  line references all hold: lazy drawer `app.orders.tsx:5`/`:2491`, loader `:210`,
  `selectedOrderId` `:949`, drawer's single write `OrderDrawer.tsx:413`.
- **Not drift, noted for fairness:** `docs/architecture.md:58` ("/app/orders —
  generic order bulk writes; no delivery writes") and `docs/api.md:34` match the
  code.

---

## Self-audit

1. **Git status (delivery-scheduler repo) — raw output at end of session:** see
   the session log. The five modified files (`claude.md`, `docs/architecture.md`,
   `docs/verification-log.md`, `shopify.web.toml`, `tsconfig.json`) and the
   untracked `docs/orders-ui.md` were **already dirty before this session began**
   (captured at session start, before any file was created); this audit added
   only `docs/proposals/`.
2. Every claim above carries a `file:line` citation or a named grep result.
3. Zero implementation code was written; the only artifact is this document.
