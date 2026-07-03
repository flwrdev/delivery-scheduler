# Known Issues

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Issue tracking for this repo lives in project memory (`project_audit_status.md`), not here. This file is a snapshot summary only — check the memory file directly for current status before proposing a fix, so your work does not collide with an in-flight fix from another session.

## Snapshot (as of the 2026-06-24 re-audit)

- **RACE-02 — Slot-capacity oversell, no atomic increment.** *Open (High).* `isSlotAtCapacity` reads a snapshot; two concurrent checkouts can both see `booked < capacity`. Needs a DB counter with atomic increment (Prisma transaction). Files: `app/lib/delivery-availability.ts`, `app/services/delivery-bookings.server.ts`. *(Only `app.orders.tsx` was re-checked in the 2026-06-24 pass; this file was not re-audited then, so treat "open" as still current until re-verified.)*
- **UX-01 — Pagination no-ops.** *Resolved,* re-verified fixed as of 2026-06-24 (`handleNextPage`/`handlePreviousPage` now set cursor URL params the loader reads back). File: `app/routes/app.orders.tsx`.
- **UX-02 — Date filter queried by tag instead of metafield.** *Resolved,* re-verified fixed as of 2026-06-24 (filter now builds `metafields.custom.date:...`). File: `app/routes/app.orders.tsx`.

> Many more issues (SEC-02/03/04, FULFILL-01/02, DATE-01..04, RACE-03, POLARIS-01/02, PROXY-01/02, DUP-01/02) are tracked in `project_audit_status.md`. This file intentionally does **not** mirror the full list — the memory file is authoritative.

## Standing action items

- **Rotate/revoke the leaked prod Lalamove + Google Maps keys.** From the 2026-07-04 verification-log entry: the keys previously committed to `.env` were deleted from the file but **MUST** be rotated/revoked at their providers. Keep this item open until a human explicitly confirms it is done — do not mark it resolved from the code side, since deletion from `.env` does not invalidate a key already exposed.

## Known dead-but-functional route (not a bug)

- **`apps.schedule-rules.reschedule.ts` has no live extension caller.** The App Proxy reschedule route still validates and writes if reached via a signed proxy URL, but no registered extension target wires to it. This is a deliberately-kept route, tracked here so nobody wires a caller to it without a product decision first. See [api.md](./api.md) and [architecture.md](./architecture.md).

## Possible future work (unconfirmed, not committed)

- **Retire `docs/delivery-operations-architecture.md` formally.** Currently an undecided team call per `architecture.md`'s "Superseded documents" section. *(As of the 2026-07-04 restructuring, this superseded file was **not found on disk** at either candidate path — see the note in [architecture.md](./architecture.md#superseded-documents). Retiring it may already be moot, but confirm before acting.)*
- **Atomic increment fix for RACE-02.** See the RACE-02 line above — a DB counter with atomic increment (Prisma transaction) is the tracked remedy.
