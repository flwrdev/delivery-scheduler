# Scheduler V2 — UX + Architecture (merged Polaris React settings page)

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).
> **Status: DESIGN FINAL (locked 2026-07-15 — merchant decisions D1–D5, see §1).
> No phase built yet.** This doc is the blueprint approved before code, same
> playbook as [orders-ops-v2-ux.md](./orders-ops-v2-ux.md). Factual foundation:
> [scheduler-v2-audit.md](./scheduler-v2-audit.md) (DEF/PERF/LEAK/DASH findings
> referenced below by ID). Booked-counts redesign is ADR-12 in
> [decisions.md](./decisions.md).

Goal: merge `/app/scheduler` (read-only dashboard, fabricated status pills) and
`/app/schedule-rules` (1,205-line mixed web-component/raw-input editor) into
**ONE compact, settings-style Polaris React page** — and, underneath it, make the
rules data layer **server-authoritative**: strict validation with field errors
instead of silent drops, one canonical slot normalizer shared by every surface,
and a booked-counts engine that doesn't scan 5,000 orders per cart view.

---

## 1. Locked decisions (D1–D5, merchant, 2026-07-15)

- **D1 — Booked counts:** replace the `created_at`-lookback full scan with
  **targeted order queries filtered by `metafields.custom.date`** (the same
  filter mechanism `/app/orders` already uses) + a **short in-memory cache**.
  DB counter with atomic increment is **deferred** until oversell becomes a real
  problem. Recorded as **ADR-12** (amends the "never cache booked counts"
  principle: still never *persisted*, now briefly *memoized*).
- **D2 — One merged page, compact settings-style.** **Orders Operations stays
  the app home** (`/app/_index` redirect changes `/app/scheduler` →
  `/app/orders`). The scheduler is a secondary/config page. **Canonical URL:
  `/app/scheduler`** (page title "Delivery Scheduler"); `/app/schedule-rules`
  becomes a redirect to it (locked here per D2's "isa ang canonical, redirect
  ang isa").
- **D3 — Modern structured slot logic, frozen output contract.** Slots are
  edited via start/end time pickers; the internal `value` is **generated, never
  hand-typed, and immutable once created**. The generated format is byte-for-byte
  the format already used by the default rules / existing orders (`"9AM-12PM"`
  shape) — tags, metafields, and customAttributes written downstream are
  unchanged. Existing configured values load verbatim.
- **D4 — Webhook keeps the data.** Late/edge webhook validation no longer
  discards a paid order's delivery data ("delivery sync blocked"): metafields +
  tags are synced whenever date+slot are parseable, validation runs with
  **checkout-time semantics** (evaluated as of the order's `created_at`, not
  webhook processing time — the grace window), and a **new additive
  `delivery.sync_status` metafield** records the outcome. Existing metafield
  values/shapes are untouched (structured, additive only).
- **D5 — No theme coupling.** Scheduler V2 is standalone and self-contained:
  the storefront proxy payload stays as-is for now (LEAK-1 consciously
  deferred), no coordinated release with `D:\Download\token`.

**Explicitly accepted risks (so they are not re-litigated):** capacity oversell
race remains possible within the cache TTL + no-reservation design (D1 —
DB counter deferred); full rules blob still served to storefront/customers
(D5 — LEAK-1 deferred); the validate endpoint stays as-is (advisory, no known
caller); the theme's client-side-only checkout gating is out of scope.

---

## 2. What changes vs. what is frozen

| Layer | Today | V2 | Change? |
| --- | --- | --- | --- |
| `/app/scheduler` (dashboard) | read-only page, hardcoded green pills, 1,890-line `home.module.css` | **canonical URL of the merged page** | **REPLACE** |
| `/app/schedule-rules` (editor) | 1,205-line route, whole-blob save, client-only validation | redirect → `/app/scheduler` | **REPLACE + REDIRECT** |
| `/app/_index` redirect | → `/app/scheduler` | → `/app/orders` (D2: Orders is home) | **CHANGE** |
| Render tree | `s-*` web components + raw inputs + 2 CSS modules | **Polaris React** (`Page`/`Card`/`Select`/`DatePicker`/`Banner`), CSS modules deleted | **REWRITE** |
| Save model | whole-blob, last-writer-wins, form wiped on revalidation | **granular per-section ops** + optimistic `version` guard | **REWRITE** |
| Server validation | trusts client; silent keep-old/drop/default-fallback | **strict schema module, field errors, loud config-health reporting** | **REWRITE** |
| Slot model | freeform `value` text input (DEF-1) | structured start/end pickers → generated immutable `value` | **REWRITE (D3)** |
| Booked counts | `created_at` lookback scan, 20×250 orders, per request | `metafields.custom.date`-scoped query + 60s in-memory cache + health status | **REWRITE (D1/ADR-12)** |
| `getScheduleRulesWithBookedCounts` signature | `(shop, admin?)` → rules | same, plus `countsMeta` (status/timestamp) | **PRESERVE (+additive)** |
| `orders/create` webhook | drops data on late validation (DEF-7) | always-sync when parseable + `delivery.sync_status` + checkout-time semantics | **REWORK (D4)** |
| Order write contract (api.md §2) | metafields/tags/attrs per contract | unchanged, **plus additive `delivery.sync_status`** | **PRESERVE (+additive)** |
| Slot `value` wire format on orders | `"9AM-12PM"` shape in tags/metafields/attrs | identical | **FROZEN** |
| Storefront proxy GET / validate / customer-account rules routes | full blob, advisory validate | unchanged | **FROZEN (D5)** |
| Reschedule routes + `rescheduleOrderDelivery()` | per ADR-10 | unchanged (benefit from cheaper counts + `excludeOrderId`) | **PRESERVE (+additive)** |
| Prisma `DeliveryScheduleConfig` | 4 scalars + 4 JSON strings | same columns **+ `version Int @default(0)`** | **ADDITIVE MIGRATION** |

**Non-negotiable preservation list:** `custom.date`, `custom.time_slot`, legacy
mirrors, `$app.reschedule_*`, `delivery.reschedule_history`, `Delivery Date`/
`Delivery Time` customAttributes, delivery tag format, `resched` tag — all
per [api.md §2](./api.md). V2 adds exactly one new metafield
(`delivery.sync_status`) and changes no existing value or shape.

---

## 3. Page hierarchy (canonical `/app/scheduler`, compact settings-style)

```
Page (title "Delivery Scheduler", narrow width — secondary config page)
├─ Health Banner(s)                ← REAL status (replaces DASH-2's fake pills):
│    · config health (strict-parse errors on stored JSON, invalid timezone, unparseable slots)
│    · booked-counts health ("Live counts refreshed <time ago>" / warning on scan error)
├─ Card "Overview"                 ← compact stat row (absorbs the old dashboard):
│    slots · upcoming blocked dates · capacity days tracked · "N full / M filling fast"
│    (chips deep-link to the sections below; watchlist = top full/near dates)
├─ Card "Delivery settings"        ← Timezone (Select, from Intl.supportedValuesOf)
│    cutoff hour (Select, 12-h labels) · prep hours · booking window (maxDays)
│    [Save] — op `saveSettings`
├─ Card "Time slots"               ← structured rows: start/end time pickers +
│    display label + generated value (read-only badge) + ↑/↓ reorder + Delete
│    (delete = confirm dialog listing affected date overrides, cascades them)
│    [Add slot] — ops `createSlot` / `updateSlotDisplay` / `reorderSlots` / `deleteSlot`
└─ Card "Date overrides"           ← ?date=YYYY-MM-DD URL-driven day panel:
     DatePicker → panel for the day: [Block entire day] toggle ·
     per-slot rows (blocked toggle · capacity number · live booked readout) ·
     [Save day] — op `saveDayOverride` / [Clear overrides] — op `clearDayOverride`
     + "Upcoming overrides" list (chips: Blocked / caps N/M) → click = ?date=
```

Interaction rules:

- **Per-section fetchers + per-section dirty state.** A section's form values
  reset from loader data **only after that section's own successful save** —
  never on unrelated revalidation (kills DEF-11's form wipe). Polaris
  contextual save-bar pattern per card; navigating away with dirty state warns.
- **`?date=` is the only cross-section URL state** (mirrors Orders V2's
  `?order=` panel contract). Old `#section-*` anchors from bookmarks map to the
  nearest card via the redirect (best effort, non-contractual).
- All action responses are **`200 + {ok, …}`** with `ok:false` + `code` +
  `fieldErrors` on any failure (validation, conflict, upstream) — the ADR-11
  Cloudflare lesson applied to this page from day one (fixes the editor's raw
  5xx path).
- Save buttons disabled while submitting (closes DUP-01).

---

## 4. Data layer (server-authoritative)

### 4.1 Strict schema module — `app/lib/schedule-rules-schema.ts` (new)

One module owns parse + validate + normalize for the whole rules shape; the
route action, the storefront loaders, and the webhook all consume it. Behavior
changes vs. today:

- **Reject, don't silently mend.** Invalid field in a write → `ok:false` +
  `fieldErrors`; nothing about "invalid input keeps the old value" (kills DEF-9).
- **Locked bounds:** `cutoffHour` 0–23 · `prepHours` 0–72 · `maxDays` 1–120
  (caps PERF-3's unbounded loops). Integers parsed with a strict `/^\d+$/` gate —
  `""`, `"1e2"`, `"0x10"` are field errors, never `0` (kills DEF-8).
- **Timezone must pass an `Intl.DateTimeFormat` probe** server-side; the UI only
  offers `Intl.supportedValuesOf("timeZone")` (kills DEF-6).
- **Real calendar-date validation** (month/day ranges verified, not regex-only —
  closes DATE-01 for config data).
- **Cross-checks enforced:** `disabledSlots`/`slotCapacity` keys must reference
  existing slot values; capacity must be a non-negative integer (closes the
  orphan/negative-capacity holes of DEF-9).
- **Loud config health on read.** A corrupt stored JSON column no longer
  silently resurrects defaults (DEF-10): `getScheduleRules` returns
  `configHealth` errors naming the column; the admin page shows a critical
  banner (raw column value preserved in logs for recovery). Storefront-facing
  paths still fall back to defaults for sales continuity — but the failure is
  now *visible* in admin instead of invisible everywhere. A valid empty
  `slots: []` is treated as exactly that (no default resurrection).

### 4.2 Canonical slot normalizer — one comparator everywhere

New `normalizeSlotValueForMatch()` (trim, case-fold, collapse spacing around the
dash) used by **(a)** `validateDeliverySelection`'s slot matching, **(b)** the
booked-counts engine, and **(c)** the webhook attribute matching. Stored and
written values remain **verbatim** (frozen contract); only *comparison* is
normalized. This single change kills DEF-2 and DEF-4 (the silent-undercount and
split-brain bugs). Unit tests assert the round-trip: every generated slot value
parses through `getSlotStartSerial` and survives its own normalization.

### 4.3 Structured slots (D3)

- Editor model: `{ start: {hour, minute, meridiem}, end: {…}, display }`.
  `value` is generated by one function whose output is asserted (by test)
  byte-identical to the existing default-rules format, and **immutable** —
  changing times = create new slot + cascade-delete old (with the confirm
  dialog), never rename in place (kills DEF-1 and DEF-12's rename hazard).
- Duplicate generated value (same start+end) → field error. Duplicate `display`
  → field error (closes the editor's inconsistent dedupe).
- **Read-time adapter for existing config:** current `{display, value}` slots
  are parsed into the structured model with the same parser; an unparseable
  legacy value (a live DEF-1 victim) surfaces in the UI as an invalid slot with
  a fix-or-delete prompt instead of being silently unbookable.
- Array order = checkout display order; ↑/↓ controls persist via `reorderSlots`.

### 4.4 Concurrency + persistence hygiene

- **`version Int @default(0)`** column added to `DeliveryScheduleConfig`
  (additive Prisma migration — "Run `npm run setup`" applies). Every granular op
  sends the loaded `version`; the server updates with a
  `WHERE version = :expected` guard and increments it. Mismatch →
  `ok:false, code:"stale_config"` + fresh rules so the UI reloads that section
  (kills DEF-11's last-writer-wins).
- **`getScheduleRules` becomes a pure read** (`findUnique`, in-memory defaults
  when the row is missing); the row is created only on first save from the
  editor (kills PERF-2's upsert-on-every-read + its P2002 first-request race).
- Granular ops (all on the `/app/scheduler` action, `op` discriminator):
  `saveSettings` · `createSlot` · `updateSlotDisplay` · `reorderSlots` ·
  `deleteSlot` (cascades matching override entries) · `saveDayOverride`
  (one date: blocked flag, blocked slots, per-slot capacities) ·
  `clearDayOverride`. Each op validates only its own inputs and rewrites only
  its own section server-side under the version guard. Past-dated override
  entries are pruned opportunistically on write (stops PERF-style unbounded
  blob growth, LOW-15).

---

## 5. Booked-counts engine V2 (D1 / ADR-12)

Replaces `loadAutomaticBookedCounts`'s `created_at`-lookback scan. Same public
entry point — `getScheduleRulesWithBookedCounts(shop, admin?)` — so **every
existing caller** (proxy GET, validate, both reschedule routes, orders page,
reschedule-rules loader, customer-account rules, editor) benefits without
signature churn; the return gains an additive `countsMeta`.

- **Query shape:** one Admin GraphQL orders search with OR-joined
  `metafields.custom.date:<date>` terms over the **future dates that have
  configured capacity** (bounded by the maxDays≤120 horizon), excluding
  cancelled orders. Fetches `id`, `cancelledAt`, and the two `custom.*`
  metafields only. Cost scales with *actual bookings on capacity-tracked days*,
  not store order volume — the 5,000-order/20-page scan and its silent
  truncation are gone (kills PERF-1/RACE-03 and DEF-13's lookback miss: the
  metafield filter finds an old order rescheduled into next week, because
  reschedules update `custom.date`).
- **Matching:** metafields ONLY (`custom.date` + `custom.time_slot`, compared
  via the §4.2 normalizer). Tag/attribute heuristics are removed from counting —
  no more promo tags fabricating bookings (DEF-15). D4 guarantees new orders
  always carry the metafields; pre-V2 "sync blocked" orders without metafields
  are consciously not counted (accepted: rare, and fixable per order via
  merchant reschedule).
- **Cache:** module-level per-shop cache of the **raw matched bookings**
  (`orderId`/`date`/`slot`), TTL **60 seconds**. Counts are derived from the
  cached set at read time, which makes **`excludeOrderId` free**: reschedule
  paths pass the order being moved so it no longer blocks itself out of a
  capacity-1 slot (kills DEF-14). The admin page gets a "Refresh counts" button
  that busts the cache.
- **Fail-open, but VISIBLE.** On scan error the capacity gate still fails open
  (merchant priority: never block sales on an internal error) — but
  `countsMeta.status = "error"` + timestamp now drive a real warning banner in
  admin instead of a fabricated green pill (turns DEF-5 from silent to
  observable; DASH-2 replaced by truth).
- The vestigial persisted `booked` field is never written non-zero and never
  read for enforcement anymore (webhook included — see §6), retiring DEF-3's
  stale-persisted-booked comparison.

---

## 6. Webhook rework (D4)

`webhooks.orders.create.ts`, behavior locked:

1. Parse `Delivery Date`/`Delivery Time` attributes exactly as today. If **no
   parseable date** → skip + warn (unchanged — nothing usable to write).
2. Run `validateDeliverySelection` with **checkout-time semantics**: "now" is
   the order payload's `created_at`, not webhook processing time — a webhook
   retried past the cutoff no longer invalidates an order that was legal when
   the customer paid (kills DEF-7). Slot matching uses the §4.2 normalizer
   (kills DEF-4's split brain).
3. **Always sync** metafields + tags when date+slot are parseable — validation
   outcome no longer gates the write. Outcome recorded in the new **additive
   metafield `delivery.sync_status`** (single-line text): `"ok"` when
   validation passed, `"attention:<code>"` otherwise (e.g. unknown slot,
   blocked date at checkout time). Existing metafields keep their exact
   values/shapes; api.md §2 row 1 gains one additive column entry.
4. Capacity is **not** enforced here (it never really was — DEF-3); over-capacity
   at sync time simply yields `attention:capacity` for merchant visibility.

Future (out of scope, noted): `/app/orders` can badge/filter
`sync_status: attention:*` orders — replaces today's invisible
"delivery sync blocked" console line with a merchant-actionable signal.

---

## 7. Routing, nav, redirects

- **`/app/scheduler`** — the merged page (loader + granular-op action).
- **`/app/schedule-rules`** — thin route: embedded-safe redirect to
  `/app/scheduler` (drops the folder route + its CSS module).
- **`/app/_index`** — default destination changes `/app/scheduler` →
  **`/app/orders`** (D2).
- **Nav (`app.jsx` s-app-nav):** `Orders Operations` · `Delivery Scheduler`
  (two items; the third disappears with the merge).
- `/app/orders/reschedule-rules` and all proxy/public/webhook routes: unchanged
  URLs (D5 / frozen).

---

## 8. Deletions (cleanup phase)

`app/routes/app.scheduler.jsx` (replaced) · `app/modules/scheduler.jsx` ·
`app/modules/scheduler.server.js` (aggregation reimplemented as a small pure
helper for the Overview card) · `app/styles/home.module.css` (1,890 lines) ·
`app/routes/app.schedule-rules/` folder incl. `styles.module.css` (replaced by
the redirect stub) · the `created_at`-lookback scan internals in
`delivery-bookings.server.ts` (tag/attribute booking heuristics included).

---

## 9. Defect coverage map

| Audit finding | V2 disposition |
| --- | --- |
| DEF-1 freeform slot value unbookable | **Fixed** §4.3 (generated values + legacy fix-or-delete prompt) |
| DEF-2 case-sensitive count match | **Fixed** §4.2 (canonical normalizer) |
| DEF-3 no capacity enforcement at creation | **Accepted** (D1: advisory model stays; counts now correct + visible; DB counter deferred) |
| DEF-4 webhook/counter split brain | **Fixed** §4.2 + §6 |
| DEF-5 fail-open capacity | **Accepted but visible** §5 (`countsMeta` + real banner) |
| DEF-6 freeform timezone bricks all | **Fixed** §4.1 (probe + Select) |
| DEF-7 webhook drops paid-order data | **Fixed** §6 (D4) |
| DEF-8 `Number("")→0` | **Fixed** §4.1 (strict integer gate) |
| DEF-9 server trusts client | **Fixed** §4.1 (reject + cross-checks) |
| DEF-10 silent default resurrection | **Fixed** §4.1 (config health; storefront default fallback stays, now visible) |
| DEF-11 blob LWW + form wipe | **Fixed** §4.4 (version guard) + §3 (per-section state) |
| DEF-12 slot rename resets accounting | **Fixed** §4.3 (immutable values) |
| DEF-13 lookback misses bookings | **Fixed** §5 (metafield-date query) |
| DEF-14 self-blocking reschedule | **Fixed** §5 (`excludeOrderId`) |
| DEF-15 tag-shaped strings fabricate bookings | **Fixed** §5 (metafields-only counting) |
| PERF-1/RACE-03 5,000-order scan per request | **Fixed** §5 (scoped query + 60s cache) — ADR-12 |
| PERF-2 upsert-on-read | **Fixed** §4.4 (pure read) |
| PERF-3 unbounded maxDays/prepHours | **Fixed** §4.1 (bounds) |
| LEAK-1 full blob to storefront | **Deferred** (D5 — future theme-coordinated track) |
| LEAK-2 products route 502s | Out of scope here (one-line ADR-11 fix; track separately) |
| RACE-02 oversell TOCTOU | **Deferred** (D1 — DB counter when oversell hurts) |
| DASH-1/2/3, POLARIS-01, DUP-01, DATE-01 (config), DATE-02 | **Fixed** by the merge/rewrite (§3/§4) |

---

## 10. Build phases (each = checkpoint commit; gates: typecheck · lint · vitest · build green; live smoke where marked)

- **Phase 0 — Docs (this doc + ADR-12).** Done 2026-07-15.
- **Phase 1 — Data layer hardening.** Schema module (§4.1), canonical
  normalizer (§4.2), pure-read `getScheduleRules`, `version` column
  (**Prisma migration → "Run `npm run setup` before your next `npm run dev`"**),
  bounds, config-health surfacing. The old editor keeps working on top (its
  well-formed payloads pass strict validation). Heavy unit-test phase.
- **Phase 2 — Booked-counts engine V2 (§5).** Swap behind the same entry point;
  `excludeOrderId` threaded to the reschedule validators; `countsMeta` additive.
  Unit tests with mocked Admin GraphQL; live dev-store verification of counts
  vs. real orders.
- **Phase 3 — The merged Polaris page (§3, §7).** Loader + granular ops + UI,
  redirects, nav, home→orders. **Live smoke checklist with the merchant** (edit
  every section, conflict path via two tabs, `?date=` deep link, legacy-slot
  fix prompt, refresh-counts button).
- **Phase 4 — Webhook rework (§6, D4).** Checkout-time semantics + always-sync +
  `delivery.sync_status`. api.md §2 updated. Unit tests + live dev-store order
  placement (incl. a deliberately-late/edge case).
- **Phase 5 — Cleanup + docs closeout.** Deletions (§8);
  architecture.md/api.md/known-issues/changelog/verification-log updates;
  final full smoke (§FST-style). **Production deploy is a separate,
  merchant-gated step** (deploy-prod runbook; `--config shopify.app.toml`).

Testing note: everything lands under `test/**/*.test.ts` (vitest); no
side-effecting e2e is required by this design (Playwright optional later).
