# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Canonical architecture doc — read before editing

**`docs/architecture.md` is the source of truth for this repo.** Before editing anything under `app/`, `extensions/`, `prisma/`, or `shopify.app.toml`, read it first. After the edit, update the relevant section in that doc and add a dated verification log entry. It documents (with file-level citations, re-verified repeatedly against the actual code) exactly which routes/extensions read vs. write delivery state — this is not derivable quickly by skimming, and getting it wrong has shipped fake "fixes" in the past (e.g. assuming an Admin extension writes delivery state when it only reads).

The one-sentence version of what it proves:
- Only **3 routes** actually mutate delivery-schedule state: `webhooks.orders.create.ts`, `apps.schedule-rules.reschedule.ts` (no live caller currently), and `public.customer-account.reschedule.ts` (the only live customer reschedule path).
- All 5 extensions except `delivery-reschedule-customer` are **read-only**. Do not assume `order-delivery-block` or `delivery-reschedule-action` can write — they can't.
- `/app/orders` mutates generic order state (archive/cancel/tag/fulfill) but never touches delivery metafields/tags/attributes directly — except via a freeform tag-text side channel merchants could abuse (documented as a caveat, not a supported path).
- Courier booking (last-mile dispatch) is handled by the **official Shopify Lalamove app**, not this app. The former custom Lalamove integration (`lalamove.*` metafields, `webhooks.lalamove.ts`, `webhooks.orders.cancelled.ts`, `app/lib/lalamove.server.ts`, in-drawer dispatch UI) was removed on 2026-07-04 — do not reintroduce it.

## Commands

```bash
npm run dev              # shopify app dev (tunnel + local dev)
npm run build             # react-router build
npm run start             # react-router-serve ./build/server/index.js
npm run typecheck         # react-router typegen && tsc --noEmit
npm run lint              # eslint, cached
npm test                  # vitest run (all tests, single run)
npm run test:watch        # vitest watch mode
npx vitest run test/verify-app-proxy.server.test.ts   # run a single test file
npm run setup              # prisma generate && prisma migrate deploy (used by docker-start)
npx prisma studio          # inspect Postgres data locally
npx playwright test --config e2e/playwright.config.ts   # e2e reschedule test (manual; see below)
```

Vitest is configured standalone (`vitest.config.ts`) — Node environment by default, no react-router plugin loaded, so server-helper unit tests run fast. Add `// @vitest-environment jsdom` per-file for component tests. Only files under `test/**/*.test.{ts,tsx}` are picked up; Playwright e2e specs live in `e2e/` (`@playwright/test`) and are excluded from the vitest run — they're invoked separately. The older duplicate `test/e2e/` and `tests/e2e/` copies were consolidated into `e2e/`, so ignore any stale references to those paths.

**No CI, tests are manual.** There is no `.github/` workflow and `npm test` is NOT part of the Cloud Run image build (`Dockerfile` only runs `npm run build`). Deploy is via the `Dockerfile` (`CMD npm run docker-start`) to Cloud Run. So nothing runs the tests automatically — run them yourself when you want a gate:
- **Unit (vitest):** `npm test` — 3 files under `test/`, pure/local, safe to run anytime.
- **E2E (Playwright):** `npx playwright test --config e2e/playwright.config.ts` — API-level test that hits the **live** deployed reschedule route against a **real** Shopify store, so it is side-effecting (mutates real order state). Needs env vars in `.env.test` (`APP_URL`, `SHOPIFY_API_KEY/SECRET`, `SHOP_DOMAIN`, `TEST_ORDER_GID`, `TEST_CUSTOMER_GID`, `TEST_NEW_DATE`, `TEST_NEW_TIME_SLOT`) — full setup + assertions in `e2e/README.md`.

## Architecture

This is a Shopify embedded app (React Router 7, not Remix — forked from the Shopify Remix template and ported) that adds delivery-date/time-slot scheduling to checkout and syncs that state onto Shopify orders. Last-mile courier dispatch is **not** handled here — it is delegated to the official Shopify Lalamove app (the former custom Lalamove integration was removed 2026-07-04).

**Delivery state lives on the Shopify order, not in Postgres.** Postgres (via Prisma) only has two models: `Session` (App Bridge OAuth sessions) and `DeliveryScheduleConfig` (one row per shop — the merchant's configured cutoff hour, prep hours, slots, disabled dates/slots, capacity). Everything about a *specific order's* delivery date/slot/reschedule status is stored as Shopify order metafields (`custom.date`, `custom.time_slot`, `$app.reschedule_status`, `$app.reschedule_requested_at`, `delivery.reschedule_history`, plus legacy mirror metafields `delivery.date`/`delivery.time_slot`/`sidekick.delivery_date`), order tags (`YYYY-MM-DD`, slot label, `resched`), and order customAttributes (`Delivery Date`, `Delivery Time`). Booked-slot counts are computed live by querying Shopify orders via Admin GraphQL — never cached locally.

**Four route surfaces, four different auth mechanisms** — know which one you're in before writing a handler:
- **Embedded admin routes** (`app/routes/app.*`) — `authenticate.admin(request)`, session-cookie-based, runs inside the Shopify Admin iframe. Three nav destinations (`app/routes/app.jsx`): **Orders** (`app.orders.tsx`), **Scheduler** (`app.scheduler.jsx`), **Schedule rules** (`app.schedule-rules/`). The Scheduler surface is **read-only** — `app/modules/scheduler.server.js` (`getSchedulerData`) computes per-slot capacity status (Open / Filling fast / Full / Closed) from live booked counts and renders `SchedulerSection`; it never mutates delivery state.
- **App Proxy routes** (`app/routes/apps.schedule-rules*.ts`) — HMAC-signed by Shopify, prefix `/apps/schedule-rules` per `shopify.app.toml`, called from storefront/theme JS.
- **Customer-account JWT routes** (`app/routes/public.customer-account.*.ts`) — verify a session token JWT passed by customer-account UI extensions; separate auth path from both of the above.
- **Webhooks** (`app/routes/webhooks.*`) — registered in `shopify.app.toml` `[[webhooks.subscriptions]]`, HMAC-verified by the Shopify webhook middleware. The live delivery-relevant subscription is `orders/create` (`webhooks.orders.create.ts`, the new-order delivery sync). The `orders/cancelled` subscription and its handler existed only for the removed custom Lalamove cancel flow and are gone.

**The reschedule lock is a single tag.** `RESCHEDULED_ORDER_TAG = "resched"` (centralized in `app/lib/constants.ts`, imported by both reschedule routes — don't reintroduce the literal) is the only thing preventing a second online reschedule. Removing that tag on the Shopify side re-opens the flow. Both reschedule routes also gate on fulfillment status and a minimum lead time (`canRescheduleDelivery`, ≥2 days ahead) via `app/lib/delivery-availability.ts`.

**Extensions (`extensions/*`) are thin clients that call back into this app's routes** — they hold no business logic of their own:
- `order-delivery-block`, `delivery-reschedule-action` — Admin order-page, read-only.
- `delivery-thank-you` — post-purchase, reads metafields via host APIs only (no backend call).
- `delivery-date-editor` — customer-account block; only `src/index.tsx` is wired in its `shopify.extension.toml`. The unregistered sibling files (`order-action-menu-item.tsx`, `order-action-modal.tsx`, `web-components.d.ts`) were moved to `_archive/extensions/delivery-date-editor/src/` — don't resurrect them expecting them to run without re-registering a target.
- `delivery-reschedule-customer` — customer-account action/modal; the only extension with a live write path, posts to `/public/customer-account/reschedule`.

**Courier booking is out of scope for this app.** Last-mile dispatch is handled by the **official Shopify Lalamove app** installed on the store. This app's own custom Lalamove integration was removed on 2026-07-04 (see `docs/architecture.md` verification log): no `lalamove.*` metafield reads/writes, no Lalamove API client, no in-drawer dispatch UI, no Lalamove callback webhook, and no `orders/cancelled` webhook remain. This app now does delivery-date/time-slot **scheduling only**. Do not reintroduce a custom dispatch surface — coordinate any courier work through the official app instead.

**Validation engine is centralized**: `app/lib/delivery-availability.ts` exports `validateDeliverySelection` and is the single place cutoff/prep-time/disabled-date/disabled-slot/capacity rules are enforced — both the App Proxy validate route and both reschedule routes call into it rather than re-implementing checks.

## Known open issues (don't re-fix, don't assume fixed)

Tracked per-issue in project memory (`project_audit_status.md`) from a prior security/reliability audit. Notably still open: slot-capacity oversell has no atomic increment (`RACE-02`). `UX-01` (pagination no-ops) and `UX-02` (date filter by tag instead of metafield) were re-verified fixed as of 2026-06-24 — don't assume the original audit list is current, check the memory file's resolved section first. Check that file before proposing a fix in these areas so work doesn't collide with a fix already in flight from another session.

## Archived dead code

`_archive/` holds files identified as unwired template scaffolding or redundant docs, moved here instead of deleted outright so the change is reversible. Not part of the live app — excluded from `tsconfig.json` (`_archive/**`). Contents: dead `delivery-date-editor` extension files (see above), `design-system.md` (a chat transcript, not a real spec), `implementation_plan.md` (a stale, already-shipped bugfix plan), a stray root `image.png`, and `.superpowers/brainstorm/*` session artifacts (ephemeral AI brainstorming tool output, not project documentation).
