# Development

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Commands, local-dev/testing notes, and deployment/cold-start notes. For the authoritative route/auth breakdown see [api.md](./api.md); for system topology see [architecture.md](./architecture.md).

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
```

> **Dev boot no longer auto-applies migrations** (commit `00482e1`): `shopify app dev` now runs only `react-router dev` (its `predev` still runs `prisma generate`, which is codegen-only — no DB connection). After creating or pulling a new Prisma migration, run `npm run setup` before your next `npm run dev`, or local dev runs against an un-migrated database. Production is unaffected — the Dockerfile's `docker-start` still runs `npm run setup`.

## Testing notes

> ⚠️ **Embedded-admin smoke tests ALWAYS hit the deployed Cloud Run build, not
> your working tree (verified live 2026-07-11).** `shopify.app.toml` sets
> `automatically_update_urls_on_dev = false`, and the SAME app (client_id
> `a9127e5f…`, handle `delivery-scheduler-11`) is installed on both the
> production store (`hsrwva-nr`) and the dev store (`flowercart-dev`). So even
> with `npm run dev` running, opening the app in EITHER store's admin — via the
> sidebar, a direct URL, or the dev-console "Web" preview link — loads the
> registered `application_url` (Cloud Run) in the `app-iframe`, i.e. the last
> DEPLOYED build. Do not flip `automatically_update_urls_on_dev` to `true` on
> this config: it would repoint the production app's URL at your tunnel while
> dev runs. To smoke-test app-home changes you must either (a) deploy to Cloud
> Run first, or (b) run dev against the SEPARATE dev app. See the
> 2026-07-11 verification-log rows.
>
> **Option (b) exists since 2026-07-11:** `shopify.app.delivery-scheduler-dev.toml`
> (name `delivery-scheduler-DEV`, own client_id `51f7d1b7…`, installed on the
> dev store `flowercart-dev` only). Run
> `npm run dev -- --config delivery-scheduler-dev` and open the app in the
> flowercart-dev admin — the iframe then serves your working tree from the
> tunnel (`automatically_update_urls_on_dev = true` is safe on THAT config
> because it is a distinct app). Caveat: the dev app's webhook
> `api_version` is `2026-10` (prod pins `2026-04`) — fine for app-home smoke
> tests, but don't use the dev app for webhook-parity testing.

Vitest is configured standalone (`vitest.config.ts`) — Node environment by default, no react-router plugin loaded, so server-helper unit tests run fast. Add `// @vitest-environment jsdom` per-file for component tests. Only files under `test/**/*.test.{ts,tsx}` are picked up; Playwright e2e specs live in `e2e/` and are excluded from the vitest run — they're invoked separately (`npx playwright test --config e2e/playwright.config.ts`).

> The former "duplicated e2e locations" TODO is resolved: `test/e2e/` and `tests/e2e/` no longer exist on disk (verified 2026-07-08) — `e2e/` is the single location. A leftover of that move (a stale `../../app/db.server.js` import in `e2e/helpers.ts`) was fixed the same day.

**Test-count history** (counts at time of writing, **not current** — the Lalamove test suites were deleted 2026-07-04, so the total dropped):
- 18/18 green — 2026-06-07 (after Lalamove hardening + first `npm test` script).
- 23/23 green — 2026-06-07 (after order drawer UI redesign).
- 31/31 green — 2026-07-02 (after adding `test/verify-app-proxy.server.test.ts`, 8 cases).
- 2026-07-04 — `test/lalamove.server.test.ts` and `test/order-drawer-flow.test.tsx` were deleted with the Lalamove removal; the current total is lower. Run `npm test` for the live count.

## Deployment notes

- **Double cold-start (Cloud Run + Neon).** Cloud Run scales to zero (`--min-instances 0`) and Neon Free Postgres auto-suspends when idle. Any route that resolved a Prisma/Neon session woke *both* on the first hit of the day, giving a 4–7s delay. Fixed for the product-pagination route by dropping its session lookup (manual App Proxy signature verification + Storefront API) — see [verification log 2026-07-02](./verification-log.md) and [decisions.md ADR-2/ADR-3/ADR-6](./decisions.md). A plain Cloud Run container cold start is still possible on the first hit of the day; the stronger fix (theme calling the Storefront API directly) was deferred to the separate theme repo.
- **Hosting setup / secrets.** See [`cloud-run-neon.md`](./cloud-run-neon.md) — the recommended low-cost Cloud Run + Neon Free path. Section **§6** covers the Storefront Access Token setup specifically.
- **`SHOPIFY_STOREFRONT_ACCESS_TOKEN` — manual one-time setup.** Required by `apps.schedule-rules.products.ts`. Configure it in **both** local `.env` and the Cloud Run secret (same pattern as `SHOPIFY_API_SECRET`). If unset, that route returns `502` — it does not fall back to the Admin API. Full steps in [`cloud-run-neon.md` §6](./cloud-run-neon.md).
- **API version pin.** `shopify.app.toml` uses `2026-04`.

## Auth mechanisms (dev-workflow angle)

For local dev, know which auth each route surface expects so you mock/fake the right one. The **authoritative** per-route breakdown lives in [api.md](./api.md#four-route-surfaces-four-different-auth-mechanisms) — this is only the dev-workflow summary:

- **Embedded admin routes** (`app/routes/app.*`) — `authenticate.admin(request)`, session-cookie-based. Locally, `shopify app dev` handles the OAuth/session for you inside the Admin iframe.
- **App Proxy routes** (`app/routes/apps.schedule-rules*.ts`) — HMAC-signed by Shopify. To hit one locally you need a validly-signed proxy URL (or, for `products.ts`, a signature that passes `verifyAppProxySignature` using `SHOPIFY_API_SECRET`).
- **Customer-account JWT routes** (`app/routes/public.customer-account.*.ts`) — verify a session-token JWT from the customer-account UI extension; a separate auth path — you need a valid session token to exercise them.
- **Webhooks** (`app/routes/webhooks.*`) — HMAC-verified by the Shopify webhook middleware; `shopify app dev` can trigger/deliver test webhook payloads.

## Coding conventions — Not yet documented

Only two evidenced patterns exist today: (1) single-source shared constants instead of duplicating literals (see [ADR-4](./decisions.md)), (2) never leak raw error objects to responses — use `.message` or a static friendly string (source: 2026-06-07 verification-log entry; the principle applies repo-wide even though the Lalamove code it originated in was later removed). Everything else (naming, file layout, import order) is undocumented — derive from a live code audit before writing a full style guide.
