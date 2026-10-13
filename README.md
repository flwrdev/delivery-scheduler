# delivery-scheduler

A Shopify embedded app for one merchant, The Flowercart (Metro Manila). It adds
delivery date and time slot scheduling to checkout, writes that choice onto the
Shopify order, and gives the merchant an orders workspace inside Shopify admin.

It is a single-merchant app, not an App Store app. The code is shared so others
can read it and help.

## What the app does

- **Delivery scheduling.** Customers pick a date and time slot. The rules are:
  cutoff hour, preparation time, booking window, time slots, blocked dates, and
  optional capacity per slot.
- **Orders page** (`/app/orders`). The merchant sees orders by delivery day and
  can reschedule, tag, fulfil, cancel, edit the shipping address, and email
  customers. Bulk actions run inline, 10 orders at most.
- **Scheduler page** (`/app/scheduler`). Edit the rules and the quick replies.
- **Checkout helpers.** Cash on delivery (COD) rules and a COD fee, plus delivery
  details on the thank-you page, order status page, customer account, and the
  admin order page.

The Shopify order is the source of truth. The database holds only Shopify
sessions, the schedule rules, and the email send log.

## Tech stack

| Area | Tool |
|---|---|
| Runtime | Node 22.12 or newer (the Docker image uses Node 22 on Alpine) |
| App framework | React Router 7 with `@shopify/shopify-app-react-router` |
| UI | React 18, Shopify Polaris 13, App Bridge |
| Language | TypeScript 5.9 (some files are still plain JavaScript) |
| Database | Postgres (Neon) through Prisma 7 and `@prisma/adapter-pg` |
| Build | Vite 7 |
| Tests | Vitest 4 (unit and extension tests), Playwright (API-level e2e) |
| Lint | ESLint 8 (`eslint:recommended` with the TypeScript parser) |
| Email | `nodemailer` (send), `imapflow` and `mailparser` (read replies) |
| Shopify | Admin GraphQL API `2026-04`, Shopify CLI, 8 extensions |
| Hosting | Google Cloud Run, built from the `Dockerfile` |

Main runtime packages: `@shopify/shopify-api`, `@shopify/polaris`,
`@shopify/polaris-icons`, `@prisma/client`, `react-router`, `isbot`, `dotenv`.
See `package.json` for exact versions.

## Extensions (`extensions/`)

| Folder | Type | Purpose |
|---|---|---|
| `cod-eligibility` | Function | Decides which payment methods show for COD |
| `cod-fee-notice` | Checkout UI | Thank-you page total with the COD fee |
| `delivery-thank-you` | Checkout UI | Delivery schedule on the thank-you page |
| `delivery-date-editor` | Customer account UI | Delivery schedule on the order status page |
| `delivery-reschedule-customer` | Customer account UI | Customer self-service reschedule |
| `delivery-reschedule-action` | Admin UI | Reschedule action on the admin order page |
| `order-delivery-block` | Admin UI | Delivery block on the admin order page |
| `delivery-fee-checker` | Theme app extension | Delivery area and fee checker |

## How requests are verified

Every endpoint is verified by Shopify: the webhook HMAC, the app proxy
signature, or a session token. There are no internal endpoints with their own
secrets and no background pollers.

## Setup

```bash
npm install
cp .env.example .env      # fill in the values below
npm run setup             # prisma generate + prisma migrate deploy
npm run dev               # shopify app dev
```

`npm run dev` does not apply migrations. Run `npm run setup` after you create
or pull a migration. Use a development database, never a production one.

### Environment variables

| Name | Needed for |
|---|---|
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | Postgres (pooled and direct) |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL` | Shopify app |
| `SHOP_CUSTOM_DOMAIN` | Optional custom shop domain |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | Collection paging on the storefront |
| `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM_NAME` | Sending customer email |
| `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT` | Optional. Reading replies (reuses the SMTP user and password) |
| `GOOGLE_MAPS_API_KEY` | Optional. Address search in the browser |

## Scripts

```bash
npm test                  # unit tests
npm run test:extensions   # extension tests
npm run test:e2e          # Playwright API tests (needs a test store)
npm run typecheck
npm run lint
npm run build
```

## Database

Postgres with Prisma. The schema is in `prisma/schema.prisma` and the
migrations are in `prisma/migrations/`. Tables: `Session`,
`DeliveryScheduleConfig`, `EmailSendLog`. Prisma reads `DIRECT_DATABASE_URL`
for migrations and the app reads `DATABASE_URL` at runtime.

## Deploy

The container runs `prisma migrate deploy` and then `react-router-serve`.
Deploy to Cloud Run from source (replace the placeholders):

```bash
gcloud run deploy delivery-scheduler --source . \
  --region <REGION> --project <PROJECT_ID> \
  --service-account <RUNTIME_SERVICE_ACCOUNT>
```

Keep secrets in Secret Manager and map them to environment variables on the
service. Never commit them. Release the Shopify app config and extensions with:

```bash
npm run deploy:prod       # shopify app deploy --config shopify.app.production.toml
```

The bare `npm run deploy` is disabled on purpose, so it cannot hit the wrong app.

## Docs

- [docs/architecture.md](docs/architecture.md): how the app works.

## Help wanted

Open an issue with what you saw, what you expected, and the steps to repeat it.
Do not post tokens, passwords, or customer data.

## License

To be chosen by the owner.
