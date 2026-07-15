# Scheduler V2 — Pre-Merge Audit (dashboard + rules editor + capacity engine)

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).
> **Status: AUDIT COMPLETE (2026-07-15). No code changes made.**
> This is the factual foundation for the proposed Scheduler V2 merge-and-modernize
> (same playbook as [orders-ops-v2-audit.md](./orders-ops-v2-audit.md) →
> [orders-ops-v2-ux.md](./orders-ops-v2-ux.md)). The V2 design doc
> (`docs/scheduler-v2-ux.md`) is written only AFTER merchant approval of the
> proposal delivered with this audit.

Scope audited (full reads, findings verified with file:line evidence):

- `app/routes/app.scheduler.jsx` + `app/modules/scheduler.jsx` + `app/modules/scheduler.server.js` + `app/styles/home.module.css`
- `app/routes/app.schedule-rules/route.tsx` (+ `styles.module.css`)
- `app/services/schedule-rules.server.ts`, `app/services/delivery-bookings.server.ts`, `app/lib/delivery-availability.ts`
- `app/routes/apps.schedule-rules.ts`, `apps.schedule-rules.validate.ts`, `apps.schedule-rules.products.ts`, `public.customer-account.schedule-rules.ts`, `webhooks.orders.create.ts`
- `prisma/schema.prisma` (`DeliveryScheduleConfig`)

Cross-references: open issues RACE-02, RACE-03, POLARIS-01, DATE-01/02, DUP-01
(project memory `project_audit_status.md`) are all confirmed still present and are
subsumed by the findings below.

---

## 1. The rules data model as it actually exists

Persisted as one Prisma row per shop (`DeliveryScheduleConfig`): 4 scalar columns
(`timezone`, `cutoffHour`, `prepHours`, `maxDays`) + 4 **stringified-JSON String
columns** (`slotsJson`, `disabledDatesJson`, `disabledSlotsJson`,
`slotCapacityJson`). No schema version, single migration, drift handled only by
silent parse-with-fallback at read time.

```ts
interface DeliveryScheduleRules {
  timezone: string;    // FREEFORM. Only checked non-empty — not validated as IANA.
  cutoffHour: number;  // 0–23. Client Number(value) coercion: "" → 0 (see DEF-8).
  prepHours: number;   // >= 0, NO upper bound.
  maxDays: number;     // >= 1, NO upper bound (O(maxDays) loops per request).
  slots: Array<{
    display: string;   // customer label; duplicates allowed.
    value: string;     // "Internal value" — FREEFORM in the editor, but secretly
                       // load-bearing: parsed as "H(:MM)AM - H(:MM)PM" AND
                       // exact-string-matched against order data (DEF-1/2/4).
  }>;
  disabledDates: string[];                       // regex-only ISO check (2026-02-31 passes).
  disabledSlots: Record<date, slotValue[]>;
  slotCapacity: Record<date, Record<slotValue, {
    capacity: number;  // editor: int >= 0; direct POST: any finite number.
    booked: number;    // VESTIGIAL — always persisted 0 by the editor, overlaid
                       // live on read; but the webhook validates against the
                       // stale persisted value (DEF-3).
  }>>;
}
```

There are **no product rules and no per-product lead times** — the only lead
mechanics are the global `cutoffHour` + `prepHours`.

---

## 2. Findings

IDs are new (`DEF-*` = defect, `PERF-*`, `LEAK-*`); mappings to the old audit IDs
noted inline. Severity reflects production impact for this flower shop.

### Critical — capacity/data integrity is not actually defended

- **DEF-1 — Slot "Internal value" is freeform but secretly a parsed time range.**
  The editor accepts any string (`route.tsx:838-853`), but availability calls
  `getSlotStartSerial` (`delivery-availability.ts:337-349`) which requires
  `"H(:MM)AM - H(:MM)PM"` split on `-`; parse failure → `isSlotAvailable` returns
  false forever (`:447-450`, verified directly). A slot value like `"morning"` or
  `"9AM-12PM-B"` (extra dash) renders in admin but is **permanently unbookable at
  checkout**, silently. The UI hint never mentions the format requirement.

- **DEF-2 — Booked-count matching is exact, case-sensitive string equality after
  inconsistent normalization → silent overbooking.** The order scan keys counts
  by `normalizeTimeSlotValue` (`delivery-bookings.server.ts:121-129`) and matches
  configured slot values case-sensitively (`:291-296`). `"9am-12pm"` config, or a
  spacing mismatch, never matches → `booked` stays 0 → `isSlotAtCapacity`
  (`delivery-availability.ts:393-404`) never trips. No warning anywhere.

- **DEF-3 — Capacity is never enforced at order creation.** The only capacity-
  aware pre-order check is the cart-time validate endpoint — advisory only, and
  no in-repo caller exists (grep hits only docs; the theme is the only plausible
  caller). The `orders/create` webhook validates with `getScheduleRules(shop)` —
  the NO-booked-counts variant (`webhooks.orders.create.ts:28`) — so it compares
  against the stale persisted `booked: 0`. And on validation failure it merely
  skips metafield/tag sync ("delivery sync blocked"): the customer still bought
  the slot. Combined with DEF-5 fail-open and the TOCTOU race (RACE-02), the
  capacity feature is best described as **advisory UI, not a guarantee**.

- **DEF-4 — Split-brain slot matching between webhook validation and the
  counter.** Webhook-time validation exact-matches the raw `Delivery Time`
  attribute against `slot.value` (`delivery-availability.ts:694-696` via
  `validateDeliverySelection`), while the booked-count scanner normalizes
  spacing/case tolerantly. A theme emitting `"9AM - 12PM"` when config says
  `"9AM-12PM"` → every order is "delivery sync blocked" (no metafields/tags) yet
  those same orders **still count toward capacity** via attributes.

- **DEF-5 — Fail-open everywhere the money is.** Booked-count scan error →
  caught, logged, rules returned with `booked` = persisted 0
  (`schedule-rules.server.ts:362-370`) → capacity gate silently OFF, exactly when
  the Admin API throttles (i.e., during high volume). Storefront proxy GET also
  fails open to DEFAULT rules when session is absent (`apps.schedule-rules.ts:9-11`,
  the SEC-02 residual).

- **DEF-6 — Timezone is a freeform text field; one typo bricks every surface.**
  Only checked non-empty (`route.tsx:752-760`, `schedule-rules.server.ts:171-173`).
  An invalid IANA name makes `Intl.DateTimeFormat` throw
  (`delivery-availability.ts:138-150`, `scheduler.server.js:5`) → storefront
  rules GET, validate, both reschedule routes, webhook, and the dashboard all
  500 — and app-proxy 5xx bodies get swallowed by Cloudflare (ADR-11).

- **DEF-7 — Webhook-time re-validation loses paid orders' delivery data.**
  `validateDeliverySelection` runs at webhook **delivery** time with cutoff/prep
  semantics (`webhooks.orders.create.ts:29-37`): an order placed at 16:58 whose
  webhook arrives 17:01 (cutoff 17) fails `date_before_min` → no metafields, no
  tags, one `console.warn`. Every scheduler surface then misses a real paid order.

### High — weak data defense (the "mahina ang depensa sa data" list)

- **DEF-8 — `Number("") === 0`:** clearing the cutoff field saves `cutoffHour: 0`
  (same-day delivery fully disabled) with a success toast
  (`route.tsx:191-210`). Also accepts `"1e2"`, `"0x10"`.
- **DEF-9 — Server trusts the client entirely.** The action accepts arbitrary
  `Partial<DeliveryScheduleRules>` JSON; `normalizeScheduleRules` silently
  keeps-old on invalid scalars (invalid `cutoffHour: 99` → 200 OK), accepts
  negative/float capacities via direct POST (`schedule-rules.server.ts:254-261`),
  and never cross-checks `disabledSlots`/`slotCapacity` keys against slot values
  (orphans persist; the editor then hard-blocks Save until each orphan is
  manually removed — `route.tsx:280-323`).
- **DEF-10 — Silent data destruction on parse failure.** Corrupt/malformed
  `slotsJson` (or even a valid empty `[]`) resurrects the hard-coded default
  slots; malformed capacity entries and non-ISO dates are silently dropped at
  normalize time (`schedule-rules.server.ts:37-161, 220-268`). A merchant's real
  blackout dates can vanish with zero signal.
- **DEF-11 — Whole-blob last-writer-wins save + form wipe.** Submit posts the
  entire rebuilt blob; `upsertScheduleRules` is read→merge→upsert with no
  version guard (`:373-388`) — two tabs clobber each other. And
  `useEffect([loaderData])` (`route.tsx:458-460`) resets the whole form on any
  revalidation → unsaved edits wiped mid-typing.
- **DEF-12 — Renaming a slot's Internal value silently resets its capacity
  accounting.** Existing orders carry the old string in metafields/tags; the
  counter matches only current configured keys → old bookings vanish from
  `booked` → slot reopens and overbooks. Nothing migrates or warns.
- **DEF-13 — Booked-count lookback misses real bookings.** Scan filters on
  `created_at >= max(35, maxDays)` days (`delivery-bookings.server.ts:249-250`)
  — an old order rescheduled to next week is invisible. Hard cap 20×250 orders;
  page 21+ silently ignored.
- **DEF-14 — Reschedule counts the order's own booking against it** (no
  exclude-self), so a capacity-1 slot can't be rescheduled within itself
  and origin slots stay inflated during a move.
- **DEF-15 — Any tag shaped like a date or slot fabricates a booking** and is
  destroyed on reschedule (`delivery-bookings.server.ts:107-110, 179-180`;
  `delivery-availability.ts:264-297`) — promo tags like `3PM-6PM` collide.

### Performance / cost

- **PERF-1 (= RACE-03) — Up to 5,000 orders + metafields scanned sequentially per
  rules read**, triggered by: every storefront cart view (proxy GET,
  `Cache-Control: no-store`), every validate POST, every customer-account rules
  POST (repeatable by any logged-in customer), both reschedule routes, the
  dashboard, the orders page, and **twice per editor save** (`route.tsx:390,413`).
  No cache, no dedupe. A bot refreshing the cart drains the Admin API bucket.
- **PERF-2 — `getScheduleRules` upserts on every read** (write-in-read,
  `schedule-rules.server.ts:343-347`) — a Neon write round-trip per storefront
  fetch + a known Prisma P2002 first-request race → unhandled 500 through the
  proxy.
- **PERF-3 — `maxDays`/`prepHours` unbounded** → O(maxDays) validation loops per
  request (`delivery-availability.ts:565-585`).

### Exposure

- **LEAK-1 — Both public rules endpoints return the ENTIRE blob** — per-date/slot
  `capacity` and live `booked` order counts to any storefront visitor
  (`apps.schedule-rules.ts:11-13`) and any logged-in customer
  (`public.customer-account.schedule-rules.ts:188-193`). The picker only needs
  labels + availability. This is merchant demand data.
- **LEAK-2 — Products route returns 502 on upstream failure**
  (`apps.schedule-rules.products.ts:128,132`) — violates ADR-11 (Cloudflare
  swallows the body). Also collection query-string injection + pagination stall
  edge cases (minor).

### Dashboard-specific (confirms the merge premise)

- **DASH-1 — 100% read-only confirmed**: zero actions/fetchers; every button is a
  `navigate()` deep-link to `/app/schedule-rules#section-*` (all 5 anchors have
  matching ids). Its only unique server logic is ~100 lines of presentational
  aggregation in `scheduler.server.js`.
- **DASH-2 — Both status pills are FABRICATED**: "Shop-specific rules active" and
  "Order counts syncing" are static always-green JSX (`scheduler.jsx:39-44`) —
  they stay green even when the booked-count scan threw (DEF-5) or never ran.
- **DASH-3 — 1,890 lines of hand-rolled CSS** (`home.module.css`) + the editor's
  own module CSS; the editor mixes `s-*` web components with raw
  `<input>`/`<select>` (= POLARIS-01), with inconsistent event semantics.

### Editor UX debt (input to the V2 design)

Single 1,205-line route; monolithic form state; flat date+slot "row list"
projection of the nested blob (source of most silent dedupe/orphan behavior);
no slot reordering (array order = checkout display order — reorder means
delete+retype, which invites DEF-1/DEF-12); duplicate handling inconsistent
(capacity dup = hard error, blocked-slot dup = silent dedupe); unhandled action
exceptions → raw 5xx (ADR-11 hazard); hash-scroll `querySelector` can throw;
no dirty-state guard; save disabled state missing (DUP-01).

---

## 3. Widget/section inventory (merge inputs)

**Dashboard widgets** (all read-only): status pills ×2 (fabricated), stat cards
(Delivery slots, Blocked dates [future-only count — differs from editor's
all-dates count], Capacity days + "N full · M filling fast", Slot blocks),
capacity watchlist (max 6, ranked Full > Filling > Tracking > Closed > Open),
full-day blocks panel (max 6), selective slot blocks panel (max 4), defaults
aside (shop/timezone/cutoff/prep/maxDays), active slots pills.

**Editor sections**: intro; sticky summary (8 live metric cards); editing tips;
Basic delivery rules (timezone/cutoff/prep/maxDays); Time slots (display +
internal value rows); Blocked dates rows; Blocked slots rows (date + slot
select); Daily slot capacity rows (date + slot + capacity + live-booked metric);
footer (error text, Save + Reset).

Both pages already share one data spine: `getScheduleRulesWithBookedCounts`.

---

## 4. Frozen contract (must survive V2 unchanged)

- Cart attributes `Delivery Date` / `Delivery Time` (+ `Card Message`,
  `cart.note`) and the theme picker DOM ids (documented in the theme repo's
  architecture doc).
- Order metafields/tags written by the §2 write paths in [api.md](./api.md)
  (`custom.date`, `custom.time_slot`, mirrors, `$app.reschedule_*`,
  `delivery.reschedule_history`, `resched` tag).
- Slot `value` strings as the order-data wire format (`"9AM-12PM"` shape) —
  existing orders carry them forever; V2 may make them generated/immutable but
  cannot change the format of values already on orders.

---

## 5. Proposal pointer

The V2 merge-and-modernize proposal (one Polaris React page; server-authoritative
validation; granular per-section save ops; booked-counts redesign options) was
delivered in-chat 2026-07-15 with decision points D1–D5. On merchant approval:
write `docs/scheduler-v2-ux.md` FIRST (docs-first rule), then phase the build.
