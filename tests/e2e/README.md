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

```powershell
cd D:\Download\LPC Issue\delivery-scheduler
npm install --save-dev @playwright/test
```

`jose` is already installed as a runtime dependency and is reused for
signing the session token.

## Required environment

Set these in a local `.env.test` (loaded via `dotenv -e .env.test --`) or
export them in PowerShell:

- `APP_URL`: `https://delivery-scheduler-XXXX.a.run.app`
- `SHOPIFY_API_KEY`: from `shopify.app.toml`
- `SHOPIFY_API_SECRET`: from Cloud Run / Secret Manager
- `SHOP_DOMAIN`: `hsrwva-nr.myshopify.com`
- `ADMIN_ACCESS_TOKEN`: optional offline `shpua_…` token with `read_orders`
  and `write_orders`; falls back to the app's stored offline session if omitted
- `TEST_ORDER_GID`: `gid://shopify/Order/6909438427323`
- `TEST_CUSTOMER_GID`: `gid://shopify/Customer/...` and it must own the order
- `TEST_NEW_DATE`: `2026-05-05` and it must be allowed by schedule rules
- `TEST_NEW_TIME_SLOT`: `3PM-6PM`

## Run

```powershell
npx playwright test --config tests/e2e/playwright.config.ts
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
