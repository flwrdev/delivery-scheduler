# delivery-scheduler

A Shopify embedded app that adds same-day and next-day **delivery date and time slot scheduling** to a flower shop, The Flowercart (Metro Manila, Philippines).

It lets customers pick a delivery date and slot, writes that choice onto the Shopify order, and gives the shop owner an orders workspace inside the Shopify admin: orders grouped by delivery day, rescheduling, tagging, fulfilment, cancel, address edits and customer email.

The repository is public so the community can help. It is built for one store (a single-merchant app), so read [CONTRIBUTING.md](CONTRIBUTING.md) before you try to run it.

## What it does

- **Delivery scheduling.** The app holds the rules (same-day cutoff, preparation time, booking window, time slots, blocked dates, optional capacity per slot) and tells the storefront which dates and slots can be booked.
- **Order operations.** `/app/orders` in the Shopify admin: delivery-first order list and panel, merchant and customer reschedule, bulk actions (up to 10 orders), customer email with photo attachments, and a notifications bell for customer replies.
- **Checkout helpers.** Cash on delivery (COD) rules and a COD fee, plus delivery information on the thank-you page, the order status page, the customer account and the admin order page.

The Shopify order is the source of truth. The database only keeps sessions, the schedule rules and a log of sent emails.

## Tech stack

| Area | What is used |
|---|---|
| Languages | TypeScript and JavaScript (ES modules), JSX/TSX, Liquid (one theme block), GraphQL, SQL (Prisma migrations) |
| Runtime | Node.js 22.12 or newer |
| Web framework | React Router 7 (framework mode, file-system routes) with React 18 |
| Shopify | `@shopify/shopify-app-react-router`, `@shopify/shopify-api`, App Bridge React, Polaris 13 (admin UI), Admin GraphQL API `2026-04`, Storefront API |
| Extensions | `@shopify/ui-extensions` 2026.4 (Preact and Polaris web components), one Shopify Function (COD eligibility), one theme app extension |
| Database | PostgreSQL (Neon in production) through Prisma 7 with the `pg` driver adapter |
| Email | `nodemailer` (SMTP send), `imapflow` and `mailparser` (IMAP read) |
| Auth helpers | `jose` (verifies customer account session tokens) |
| Build | Vite 7 |
| Tests | Vitest 4 (unit and extension tests), Vitest 3 (COD function), Playwright (API-level end-to-end) |
| Lint and types | ESLint 8 (`eslint:recommended` plus the TypeScript parser), TypeScript 5.9 `strict`, EditorConfig |
| Hosting | Google Cloud Run (container from the `Dockerfile`), Secret Manager, Artifact Registry |

## Quick start

```bash
npm install
cp .env.example .env      # then fill it in, see docs/development.md
npm run setup             # prisma generate + prisma migrate deploy (uses DIRECT_DATABASE_URL)
npm test                  # unit tests, no network, no side effects
npm run test:extensions   # extension render tests
npm run typecheck && npm run lint && npm run build
```

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build` work without any Shopify account or database. Running the app itself needs your own Shopify dev app and dev store. [docs/development.md](docs/development.md) walks through it.

## Documentation

| File | Read it for |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to help: setup, workflow, code style, tests, pull requests |
| [docs/development.md](docs/development.md) | local setup in detail: Shopify dev app, database, environment variables, tooling |
| [docs/architecture.md](docs/architecture.md) | how the app works: flows, data on the order, trust boundaries, extensions |
| [docs/runbook.md](docs/runbook.md) | production deploys and known errors (maintainer only) |
| [docs/gcp-inventory.md](docs/gcp-inventory.md) | Google Cloud resources and secret names (maintainer only) |
| [e2e/README.md](e2e/README.md) | the end-to-end reschedule test |
| [SECURITY.md](SECURITY.md) | how to report a security problem |
| [CLAUDE.md](CLAUDE.md) | rules for AI coding agents working in this repo |

## Production

Production runs on Google Cloud Run (`delivery-scheduler`, `us-central1`) with Neon Postgres. Only the maintainer deploys. Contributors never need production access; see [docs/runbook.md](docs/runbook.md) for how deploys work.
