# Contributing

Thanks for helping. This app runs a real flower shop, so changes are reviewed with care. This page tells you how to get set up, how to make a change, and what a good pull request looks like.

## Before you start

- This is a **single-merchant** Shopify app. It serves one store. Features that only make sense for many stores are out of scope unless the maintainer agrees first.
- Open an issue before a large change (new feature, new dependency, schema change, new extension). Small fixes (typos, tests, clear bugs) can go straight to a pull request.
- You never need access to production, the production database or Google Cloud. Only the maintainer deploys.

## Setup

Short version:

```bash
git clone https://github.com/flwrdev/delivery-scheduler
cd delivery-scheduler
npm install
npm test
```

To run the app itself you need your own Shopify dev app, dev store and Postgres database. Full steps: [docs/development.md](docs/development.md).

## Where things are

| Path | What lives there |
|---|---|
| `app/routes` | pages, resource routes, app proxy endpoints, webhooks (file-system routing: `app.orders.tsx` is `/app/orders`) |
| `app/services` | code that talks to Shopify, Postgres or the mailbox (`*.server.ts`) |
| `app/lib` | pure logic: rules engine, tag vocabulary, order helpers, email parsing |
| `app/components` | Polaris screens for the Orders and Scheduler pages |
| `app/hooks` | React hooks (refresh, diff, bulk actions, clipboard) |
| `app/data` | Metro Manila ZIP code and barangay list |
| `extensions` | Shopify extensions: checkout, order status, customer account, admin, COD function, theme block |
| `prisma` | database schema and migrations |
| `test` | unit tests (Vitest) |
| `e2e` | end-to-end reschedule test (Playwright, needs a real store) |

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together. Read it before changing anything in `app/services` or the webhook.

## Workflow

1. Fork the repo and create a branch from `main`: `fix/slot-label-trim`, `feat/...`, `docs/...`.
2. Make the change. Keep a pull request to one topic.
3. Run the checks (there is no CI, so this is on you):
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run test:extensions   # if you touched extensions/ or shared lib code they use
   npm run build
   ```
4. Open a pull request against `main` and fill in the template.

Commit messages: one short line in plain English that says what changed (`Fix slot matching when the label has extra spaces`). Add a body if the reason is not obvious.

## Code style

- **TypeScript for new code** (`.ts`/`.tsx`). Some older files are `.js`/`.jsx`; leave them unless you are already changing them.
- ES modules only (`import`/`export`).
- Server-only code goes in files ending in `.server.ts` so it never ships to the browser.
- Admin UI uses Polaris (`@shopify/polaris`). Extensions use `@shopify/ui-extensions` (Preact or Polaris web components, follow the extension you are in).
- Indentation and line endings follow `.editorconfig` (2 spaces). There is no Prettier; match the file you edit.
- **Comments:** every function or block you add or change gets a comment above it that says what it does, in plain English a grade 8 student can follow. Each file keeps a short comment at the top saying what the file is for; update it when the file changes.
- Prefer small, pure functions in `app/lib` with unit tests in `test/`.

## Tests

- New logic in `app/lib` or `app/services` needs a test in `test/` named after the file (`order-tags.ts` is tested by `test/order-tags.test.ts`).
- Mock Shopify GraphQL calls; unit tests must not hit the network.
- Extension UI tests go in `extensions/<name>/tests/` and run with `npm run test:extensions`.

## Things that need extra care

These are relied on by the shop owner's own automations or by live orders. Change them only after discussing it in an issue.

- **Order tags.** The schedule tags are the bare date and slot (`2026-10-03`, `9AM-12PM`). The shop's order list, email notifications and analytics depend on them. The vocabulary lives in `app/lib/order-tags.ts`.
- **Order metafields** (`custom.date`, `custom.time_slot` and their mirrors). See the table in [docs/architecture.md](docs/architecture.md).
- **Stored slot values** (`9AM-12PM`). Nothing rewrites a stored value; `app/lib/slot-value.ts` matches variants.
- **Prisma migrations.** Add new migrations; never edit or delete one that is already on `main`.
- **Request verification.** Every endpoint is verified by Shopify (session token, webhook HMAC or app proxy signature). Do not add endpoints with their own secrets or that skip verification.
- **`shopify.app.production.toml`.** This is the live app config. Do not change it in a pull request unless the issue asks for it, and never commit your own `shopify.app.<name>.toml`.
- **Dependencies.** Ask before adding one. Use `npm install` so `package-lock.json` updates, and commit the lockfile.

## Secrets

Never commit `.env`, tokens, passwords, database URLs or API secrets. `.env` and `.env.*` are gitignored (except `.env.example`). If you think you found a leaked secret or a security bug, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## AI coding agents

If you use an AI agent, [CLAUDE.md](CLAUDE.md) holds the project rules for agents. The same review standard applies to AI-written code.
