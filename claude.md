# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick orientation

Shopify embedded app (React Router 7, ported from the Shopify Remix template)
na nagdaragdag ng delivery-date / time-slot scheduling sa checkout at nag-si-sync
ng state na iyon papunta sa Shopify orders.

- **Delivery state lives on the Shopify ORDER, not in Postgres.** Postgres holds
  four Prisma models (`Session`, `DeliveryScheduleConfig`, plus the Messenger
  agent's `MessengerThread`/`MessengerMessage` conversation pair — conversation
  only, never the order); a specific order's date/slot/reschedule status lives
  as order metafields, tags, and customAttributes.
- **Booked-slot counts are computed live** via Admin GraphQL on every call — never
  cached locally, walang audit table (the `delivery.reschedule_history` metafield is
  the only persistent reschedule audit trail).
- **Only a few surfaces write delivery state.** Most extensions and admin order-page
  blocks are read-only. Never assume a surface writes — verify in `docs/api.md`.
- **Courier dispatch is out of scope** — handled by the official Shopify Lalamove app.
- **The app sends customer emails itself** via the merchant's Private Email SMTP
  mailbox (`app/services/send-customer-email.server.ts`, in-app compose modal on
  `/app/orders`) — zero order writes. Route-op upstream failures must return
  `200 + ok:false`, never 5xx — Cloudflare replaces origin 502/504 bodies with
  its HTML error page and breaks the embedded fetcher (see ADR-11).

The full topology + data model is in `docs/architecture.md`; the route/auth/write-path
contract is in `docs/api.md`. Those docs are the source of truth — this section is only
a first-glance mental model.

## Commands

```bash
npm run dev        # shopify app dev against the DEV app (default, safe); does NOT auto-apply migrations
npm run dev:prod-preview # shopify app dev against the PROD app config (read-only preview; automatically_update_urls_on_dev=false there)
npm run build      # react-router build
npm run start      # react-router-serve ./build/server/index.js
npm run typecheck  # react-router typegen && tsc --noEmit
npm run lint       # eslint, cached
npm test           # vitest run (all tests, single run)
npm run test:watch # vitest watch mode
npm run setup      # prisma generate && prisma migrate deploy (run after any new migration)
npx prisma studio  # inspect Postgres data locally

npx vitest run test/verify-app-proxy.server.test.ts   # run a single vitest file
npx playwright test --config e2e/playwright.config.ts # e2e (separate from vitest; live side effects)

# Production deploys (merchant go required — stop-and-ask gate):
gcloud run deploy delivery-scheduler --source . --region us-central1   # backend (project lalamove-map)
npm run deploy:prod                                                     # app config + extensions to the PROD app
# ⚠️ NEVER use the bare `shopify app deploy` / `npm run deploy` — always npm run deploy:dev
# or npm run deploy:prod explicitly. (shopify.app.toml = DEV, shopify.app.production.toml = PROD,
# swapped 2026-07-31 after a bare deploy hit the DEV app on 2026-07-13; see ADR-14.)
```

Only `test/**/*.test.{ts,tsx}` are picked up by vitest; `e2e/` specs are excluded and
run separately. API version is pinned per config: `2026-04` in `shopify.app.production.toml`
(prod), `2026-04` in `shopify.app.toml` (dev — see `docs/development.md` for any drift
between the file and what's live on Partners). Full dev / testing / deployment (Cloud Run +
Neon cold-start) notes are in `docs/development.md`.

## Read before editing (source of truth)

Read in this order before touching `app/`, `extensions/`, `prisma/`,
or `shopify.app.toml` / `shopify.app.production.toml`:

1. `docs/architecture.md` — system topology + data model (source of truth)
2. `docs/api.md` — routes, auth mechanisms, order write-path contract
3. `docs/known-issues.md` — don't collide with in-flight fixes
4. `docs/development.md` — commands, dev/testing/deployment notes

Rules:

- Never assume a write path — verify it in `docs/api.md` first.
- After any architectural change: update the relevant doc(s) +
  `docs/verification-log.md`, and add an entry to `docs/changelog.md`
  and/or `docs/decisions.md` if applicable.
- Courier dispatch is out of scope — handled by the official Shopify
  Lalamove app. Do not reintroduce custom Lalamove code
  (see `docs/decisions.md` ADR-1).
- After creating or pulling any new Prisma migration, explicitly tell
  the user: "Run `npm run setup` before your next `npm run dev`" —
  dev boot no longer auto-applies migrations (see shopify.web.toml
  commit 00482e1).
