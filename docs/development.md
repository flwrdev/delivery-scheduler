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

> ⚠️ **`npm run dev` (default, no flags) now runs against the separate DEV
> app — the safe default since the 2026-07-31 config swap (ADR-14).**
> `shopify.app.toml` (unnamed/default file) is `delivery-scheduler-DEV` (own
> client_id `51f7d1b7…`, installed on the dev store `flowercart-dev` only,
> `automatically_update_urls_on_dev = true` is safe on this config because
> it's a distinct app). Open the app in the `flowercart-dev` admin — the
> iframe then serves your working tree from the tunnel. Caveat: verify the
> dev app's webhook `api_version` in `shopify.app.toml` before trusting it
> for webhook-parity tests — it has drifted from prod's `2026-04` pin before.
>
> **To smoke-test against the deployed PROD build instead** (verified live
> 2026-07-11): run `npm run dev:prod-preview` (`--config shopify.app.production.toml`).
> Embedded-admin smoke tests through THAT config ALWAYS hit the deployed
> Cloud Run build, not your working tree — `shopify.app.production.toml` sets
> `automatically_update_urls_on_dev = false`, and the SAME app (client_id
> `a9127e5f…`, handle `delivery-scheduler-11`) is installed on both the
> production store (`hsrwva-nr`) and the dev store (`flowercart-dev`). So even
> with `dev:prod-preview` running, opening the app in EITHER store's admin —
> via the sidebar, a direct URL, or the dev-console "Web" preview link — loads
> the registered `application_url` (Cloud Run) in the `app-iframe`, i.e. the
> last DEPLOYED build, NOT your tunnel. Do not flip
> `automatically_update_urls_on_dev` to `true` on `shopify.app.production.toml`:
> it would repoint the production app's URL at your tunnel while dev runs. To
> smoke-test app-home changes against your working tree, use the default
> `npm run dev` (DEV app) instead. See the 2026-07-11 verification-log rows.

> **Customer-account extension dev-testing caveat (2026-07-13).** The
> `delivery-reschedule-customer` extension hardcodes `APP_BASE_URL` to the
> production Cloud Run URL (`order-action-modal.tsx`). On the dev store BOTH
> installed apps render their own "Reschedule Delivery" button, and the DEV
> app's modal always fails **401 Unauthorized** — its session token is signed
> for the dev app but lands on the prod backend (`jwtVerify` with the prod
> secret + `aud` check). This is a dev-environment artifact, not a bug. To
> smoke-test the customer reschedule against your working tree, temporarily
> point `APP_BASE_URL` at the current tunnel URL (the extension draft
> hot-rebuilds), run the flow from the modal whose intro text matches the
> working tree, then REVERT the constant before committing. See the
> 2026-07-13 §8-FST verification-log row for a worked example.

Vitest is configured standalone (`vitest.config.ts`) — Node environment by default, no react-router plugin loaded, so server-helper unit tests run fast. Add `// @vitest-environment jsdom` per-file for component tests. Only files under `test/**/*.test.{ts,tsx}` are picked up; Playwright e2e specs live in `e2e/` and are excluded from the vitest run — they're invoked separately (`npx playwright test --config e2e/playwright.config.ts`).

**Extension render-level tests (2026-08-19):** `npm run test:extensions` runs a SECOND vitest config (`vitest.extensions.config.ts` — jsdom + `@shopify/ui-extensions-tester`) over `extensions/*/tests/**`. These execute each extension's REAL default export against the tester's mock `shopify` global and query the rendered `s-*` DOM. Notes: (1) the tester devDep is pinned EXACT `2026.4.4` because the tester enforces a match with each toml's `api_version = "2026-04"` — bump them together; (2) `server.deps.inline: ["@shopify/ui-extensions-tester"]` in that config is a Windows fix (the tester dynamic-imports the extension module by absolute `c:\` path, which Node's ESM loader rejects — Vite's resolver must handle it); (3) the mock `shopify` proxy THROWS on reads of properties the target doesn't declare, and subscribable mocks expose both `.value` and `.current` — set both; (4) `extensions/cod-eligibility/tests/` is excluded — the Function's wasm test runs under its own vitest 3 config via `npm test --workspace=extensions/cod-eligibility`. Root `npm test` is untouched by all of this.

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
- **API version pin.** `shopify.app.production.toml` (PROD) pins `2026-04`; verify `shopify.app.toml` (DEV) separately, it has drifted before.

### Where this app actually lives — NOT the Partner Dashboard

The app is managed in the **Dev Dashboard**, and the merchant has **no Partner
organization at all**:

```
https://dev.shopify.com/dashboard/163673913/apps/349939269633
   org 163673913 · app 349939269633 · client_id a9127e5f8228762411a021805a397069
```

Visiting `partners.shopify.com` shows *"How would you like to get started as a
partner?"* and asks you to create or join an organization — there is nothing
there to find. Large parts of shopify.dev still say *"Go to your Partner
Dashboard"*; **those steps do not apply to this app.** Cost us a long search on
2026-08-22. Always give the full `dev.shopify.com/dashboard/...` URL rather than
describing a navigation path.

### `[sidekick] extensions_summary` is required for every release

While the `delivery-sidekick-*` extensions exist, a release is **rejected**
without a `[sidekick]` section:

```
Version couldn't be created.
  • An extensions_summary is required when sidekick-eligible extensions are present.
```

It must be present in **whichever config you are deploying**. On 2026-08-22
`npm run deploy:prod` failed because only `shopify.app.toml` (DEV) carried the
block and `shopify.app.production.toml` had never been given a copy. Keep the two
byte-identical; if you edit one, edit the other.

### `network_access` needs no dashboard approval here

The customer-account `delivery-reschedule-customer` and `delivery-date-editor`
extensions declare `network_access = true` in their `shopify.extension.toml`, and
`npm run deploy:prod` released them with **no approval step and no dashboard toggle**
(first observed on the since-removed `support-chat` extension, 2026-08). The docs'
["Request network access" flow](https://shopify.dev/docs/apps/build/customer-accounts/capabilities)
routes through the Partner Dashboard, which this app does not have. Do not go
hunting for that toggle — declare the capability in the extension TOML and deploy.

### Migrations apply themselves on deploy

`Dockerfile` ends with `CMD ["npm", "run", "docker-start"]` →
`npm run setup && npm run start` → `prisma generate && prisma migrate deploy`.
So a Cloud Run deploy applies every pending migration against PROD Neon **before
the container serves traffic**. Two consequences:

- You do **not** run migrations by hand for PROD — write the SQL, commit it, deploy.
- A broken migration means the container never becomes ready, so Cloud Run keeps
  the previous revision serving. Failure is safe, but the deploy will look "done"
  while traffic is still on the old revision — **always confirm the traffic split**,
  not just the revision list:

```bash
gcloud run services describe delivery-scheduler --region us-central1 --format="yaml(status.traffic)"
```

Note the `mdclean` tagged revision (`delivery-scheduler-00102-b5f`) appears in that
output with its own URL and **0%** traffic. It is not the serving revision — read
the entry with `latestRevision: true` and `percent: 100`.

Rollback is one command:

```bash
gcloud run services update-traffic delivery-scheduler \
  --region us-central1 --to-revisions <previous-revision>=100
```

A single `Error obtaining session table: PrismaClientInitializationError` right
after a new revision starts is the expected Neon cold start, not a failure — it
should not repeat.

## Auth mechanisms (dev-workflow angle)

For local dev, know which auth each route surface expects so you mock/fake the right one. The **authoritative** per-route breakdown lives in [api.md](./api.md#four-route-surfaces-four-different-auth-mechanisms) — this is only the dev-workflow summary:

- **Embedded admin routes** (`app/routes/app.*`) — `authenticate.admin(request)`, session-cookie-based. Locally, `shopify app dev` handles the OAuth/session for you inside the Admin iframe.
- **App Proxy routes** (`app/routes/apps.schedule-rules*.ts`) — HMAC-signed by Shopify. To hit one locally you need a validly-signed proxy URL (or, for `products.ts`, a signature that passes `verifyAppProxySignature` using `SHOPIFY_API_SECRET`).
- **Customer-account JWT routes** (`app/routes/public.customer-account.*.ts`) — verify a session-token JWT from the customer-account UI extension; a separate auth path — you need a valid session token to exercise them.
- **Webhooks** (`app/routes/webhooks.*`) — HMAC-verified by the Shopify webhook middleware; `shopify app dev` can trigger/deliver test webhook payloads.

## Coding conventions — Not yet documented

Only two evidenced patterns exist today: (1) single-source shared constants instead of duplicating literals (see [ADR-4](./decisions.md)), (2) never leak raw error objects to responses — use `.message` or a static friendly string (source: 2026-06-07 verification-log entry; the principle applies repo-wide even though the Lalamove code it originated in was later removed). Everything else (naming, file layout, import order) is undocumented — derive from a live code audit before writing a full style guide.
