# delivery-scheduler E2E tests

Playwright API-level tests that validate the customer-account reschedule
route end-to-end against a real Shopify store and the deployed app.

## Why API-level instead of UI-driven

The reschedule UI ships as a Customer Account UI Extension that renders
inside a Shopify-hosted iframe (`https://extensions.shopifycdn.com`). That
iframe is not a stable Playwright target: selectors are obfuscated, login
requires a Shop login challenge, and the surface changes with every
extension version. The reschedule **route** (`/public/customer-account/reschedule`)
is the actual unit under test: the UI just POSTs to it with a session
token. Mint the token, hit the route, then assert state via Admin GraphQL.

## Setup

`@playwright/test` is already a devDependency, so `npm install` is all the
tooling setup needed (the suite is API-level, so no browser binaries are
required). `jose` signs the session token; it is installed as a dependency of
the Shopify packages, not listed in `package.json` directly.

## Required environment

Create `.env.test` in the repo root (it is gitignored, never commit it).
`e2e/playwright.config.ts` loads it automatically, and real environment
variables win over file values.

**This suite really reschedules an order.** Run it only against your own dev
store and your own app, never against the production app.

- `APP_URL`: the app URL your dev store talks to
- `SHOPIFY_API_KEY`: `client_id` of that app
- `SHOPIFY_API_SECRET`: the secret of that app
- `SHOP_DOMAIN`: your dev store, for example `your-dev-store.myshopify.com`
- `ADMIN_ACCESS_TOKEN`: optional offline Admin API token with `read_orders`
  and `write_orders`; if omitted the suite reads the app's stored offline
  session from Postgres, so `DATABASE_URL` must then also be set
- `TEST_ORDER_GID`: `gid://shopify/Order/...`, a **test or archived order**,
  never a live customer order
- `TEST_CUSTOMER_GID`: `gid://shopify/Customer/...`, must own the order
- `TEST_NEW_DATE`: `YYYY-MM-DD`, must be allowed by the **current** schedule
  rules (future, inside the window, not blocked, slot not full)
- `TEST_NEW_TIME_SLOT`: a slot value such as `3PM-6PM`

## Run

```bash
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
5. `order.tags` contains exactly the two bare schedule tags
   `<TEST_NEW_DATE>` and `<TEST_NEW_TIME_SLOT>`.
6. Repeating the same reschedule keeps exactly those schedule tags and preserves unrelated order tags.
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
  did not run; check the app logs for `userErrors`.
- Tags correct but metafields wrong → admin metafield definitions for
  `custom.date` and `custom.time_slot` may be missing. They must exist
  with `cartToOrderCopyable` for cart-write parity.
