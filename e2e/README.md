# delivery-scheduler E2E tests

Playwright API-level tests that validate the customer-account reschedule
route end-to-end against a real Shopify store and the deployed app.

## Why API-level instead of UI-driven

The reschedule UI ships as a Customer Account UI Extension that renders
inside a Shopify-hosted iframe (`https://extensions.shopifycdn.com`). That
iframe is not a stable Playwright target: selectors are obfuscated, login
requires a Shop login challenge, and the surface changes with every
extension version. The reschedule **route** (`/public/customer-account/reschedule`)
is the actual unit under test — the UI just POSTs to it with a session
token. Mint the token, hit the route, then assert state via Admin GraphQL.

## Setup

`@playwright/test` is already a devDependency — a plain `npm install` is all
the tooling setup needed (the suite is API-level, so no browser binaries are
required). `jose` is already installed as a runtime dependency and is reused
for signing the session token.

## Required environment

Copy `.env.test.example` (repo root) to `.env.test` and fill in the blanks —
`e2e/playwright.config.ts` loads `.env.test` automatically, and real
environment variables win over file values. `.env.test` is gitignored; never
commit real values.

- `APP_URL`: the deployed app, e.g. `https://delivery-scheduler-XXXX.us-central1.run.app`
- `SHOPIFY_API_KEY`: `client_id` from `shopify.app.production.toml`
- `SHOPIFY_API_SECRET`: from the Partner Dashboard / Secret Manager
- `SHOP_DOMAIN`: `hsrwva-nr.myshopify.com`
- `ADMIN_ACCESS_TOKEN`: optional offline `shpua_…` token with `read_orders`
  and `write_orders`; falls back to the app's stored offline session if omitted
  (the fallback reads Postgres, so `DATABASE_URL` must then also be set in
  `.env.test`)
- `TEST_ORDER_GID`: `gid://shopify/Order/6909438427323` — use a **safe
  test/archived order**, never a live customer order (the suite really
  reschedules it)
- `TEST_CUSTOMER_GID`: `gid://shopify/Customer/...` and it must own the order
- `TEST_NEW_DATE`: `YYYY-MM-DD`, must be allowed by the **current** schedule
  rules (future, inside the window, not blocked, slot not full)
- `TEST_NEW_TIME_SLOT`: `3PM-6PM`

## Run

```powershell
npm run test:e2e
# equivalent to: npx playwright test --config e2e/playwright.config.ts
```

## What it asserts

1. `POST /public/customer-account/reschedule` returns `200` with
   `{ ok: true, deliveryAttributeSync: "updated", deliveryTagSync: "updated" }`.
2. `order.metafield(custom.date)` equals `TEST_NEW_DATE`.
3. `order.metafield(custom.time_slot)` equals `TEST_NEW_TIME_SLOT`.
4. `order.customAttributes["Delivery Date"]` equals `TEST_NEW_DATE` and
   `order.customAttributes["Delivery Time"]` equals `TEST_NEW_TIME_SLOT`.
5. `order.tags` contains exactly one schedule tag:
   `<TEST_NEW_DATE> | <TEST_NEW_TIME_SLOT>`.
6. Repeating the same reschedule keeps exactly one active schedule tag and preserves unrelated order tags.
7. Tags, metafields, and legacy attributes agree.

A poll wraps the metafield assertion to absorb up to ~20 s of Admin API
indexing latency.

## Diagnosing a failure

- `body.ok === false` → the route rejected the request. Check `body.error`:
  validation, ownership mismatch, schedule rule rejection.
- `body.ok === true` but `body.deliveryTagSync === "failed"` → metafields
  saved but `tagsRemove` or `tagsAdd` returned errors. Inspect Cloud Run
  logs for `userErrors` from the mutation responses.
- `body.ok === true` but `body.deliveryAttributeSync === "failed"` → metafields
  saved but `orderUpdate(customAttributes)` returned errors, so Admin
  Additional details likely stayed stale.
- Metafields correct but tags wrong → the `tagsRemove` + `tagsAdd` pair
  did not run; verify the route version is `delivery-scheduler-47` or
  later (this is the version where the orderUpdate-based tag rebuild was
  replaced with explicit add/remove).
- Tags correct but metafields wrong → admin metafield definitions for
  `custom.date` and `custom.time_slot` may be missing. They must exist
  with `cartToOrderCopyable` for cart-write parity.
