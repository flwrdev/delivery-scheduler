# Known Issues

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Issue tracking for this repo lives in project memory (`project_audit_status.md`), not here. This file is a snapshot summary only — check the memory file directly for current status before proposing a fix, so your work does not collide with an in-flight fix from another session.

## Snapshot (as of the 2026-06-24 re-audit)

- **RACE-02 — Slot-capacity oversell, no atomic increment.** *Open by conscious decision (Scheduler V2 D1 / ADR-12, 2026-07-15).* `isSlotAtCapacity` reads a snapshot; two concurrent checkouts can both see `booked < capacity` (window widened slightly by the 60s counts cache, and further whenever a scan cap makes the counts a lower bound — `countsMeta.status: "partial"`, 2026-07-29). The merchant deferred the DB-counter remedy until oversell hurts in practice; since Phase 4 (D4, 2026-07-17) an over-capacity order at least lands **visibly** as `delivery.sync_status: attention:capacity` instead of silently. Files: `app/lib/delivery-availability.ts`, `app/services/delivery-bookings.server.ts`.
- **UX-01 — Pagination no-ops.** *Resolved,* re-verified fixed as of 2026-06-24 (`handleNextPage`/`handlePreviousPage` now set cursor URL params the loader reads back). File: `app/routes/app.orders.tsx`.
- **UX-02 — Date filter queried by tag instead of metafield.** *Resolved,* re-verified fixed as of 2026-06-24 (filter now builds `metafields.custom.date:...`). File: `app/routes/app.orders.tsx`.

> Many more issues (SEC-02/03/04, FULFILL-01/02, DATE-01..04, RACE-03, POLARIS-01/02, PROXY-01/02, DUP-01/02) are tracked in `project_audit_status.md`. This file intentionally does **not** mirror the full list — the memory file is authoritative.

- **Scheduler audit families closed by Scheduler V2 (Phases 1–5, 2026-07-15 → 2026-07-17).** The DEF-1..15 / PERF-1..3 / DASH-1..3 / RACE-03 / POLARIS-01 / DUP-01 findings from [scheduler-v2-audit.md](./scheduler-v2-audit.md) are now fixed or consciously accepted — the per-finding disposition table is [scheduler-v2-ux.md §9](./scheduler-v2-ux.md#9-defect-coverage-map). Still deliberately open: RACE-02 (above) and LEAK-1 (full rules blob served to storefront/customer payloads — D5 deferral, needs a future theme-coordinated track).
  - *Two of those closures were narrower than recorded (found + fixed 2026-07-29, see the verification log).* **DEF-2/DEF-4** were closed for *counting* only — the `disabledSlots`/`slotCapacity` lookups stayed strict, so a cap or block stored under a drifted key spelling was never enforced at checkout ([ADR-13](./decisions.md)). **DEF-5**'s "fail-open but visible" held for scan *errors* only — the engine's two truncation caps stayed silent under an `"ok"` `countsMeta`; truncation is now `countsMeta.status: "partial"` + a banner.

## Standing action items

- **Prisma 7 upgrade blocked (2026-07-11).** `@shopify/shopify-app-session-storage-prisma@9.0.1` (latest) still peers `prisma`/`@prisma/client` at `^6.19.0`, so upgrading to Prisma 7.x breaks the dependency chain. Stay on the **6.19.x** line (currently pinned `^6.19.3`) until Shopify publishes a session-storage release that supports Prisma 7 — check `npm view @shopify/shopify-app-session-storage-prisma@latest peerDependencies` before any future Prisma bump. Also: keep the `prisma` CLI in **dependencies**, not devDependencies — Cloud Run's `docker-start` runs `prisma migrate deploy` at container start.
- **Rotate/revoke the leaked prod Lalamove + Google Maps keys.** From the 2026-07-04 verification-log entry: the keys previously committed to `.env` were deleted from the file but **MUST** be rotated/revoked at their providers. Keep this item open until a human explicitly confirms it is done — do not mark it resolved from the code side, since deletion from `.env` does not invalidate a key already exposed.

## Known dead-but-functional route (not a bug)

- **`apps.schedule-rules.reschedule.ts` has no live extension caller.** The App Proxy reschedule route still validates and writes if reached via a signed proxy URL, but no registered extension target wires to it. This is a deliberately-kept route, tracked here so nobody wires a caller to it without a product decision first. See [api.md](./api.md) and [architecture.md](./architecture.md).

## Possible future work (unconfirmed, not committed)

- **Retire `docs/delivery-operations-architecture.md` formally.** Currently an undecided team call per `architecture.md`'s "Superseded documents" section. *(As of the 2026-07-04 restructuring, this superseded file was **not found on disk** at either candidate path — see the note in [architecture.md](./architecture.md#superseded-documents). Retiring it may already be moot, but confirm before acting.)*
- **Atomic increment fix for RACE-02.** See the RACE-02 line above — a DB counter with atomic increment (Prisma transaction) is the tracked remedy.
