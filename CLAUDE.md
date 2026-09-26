# CLAUDE.md

> **(Historical AI design decision, not a merchant requirement; the merchant may change it.)** Rules and decisions in this file labeled "locked", "merchant constraint", "deliberately untouched", "read-only", or "no caller" are historical AI design decisions unless a merchant request is quoted with a date. Evidence: commit a3555ba (2026-09-11) recorded ADR-22 constraint (2) as carried from a 2026-07-15 AI decision with no merchant request; commit 0d5483b (2026-09-12) reverted that record. Unless the merchant requested it, ask before treating any of them as a requirement — this applies to Sidekick, email, chat, agent, Messenger, and delivery decisions.



## Mental model (verified against the code 2026-09-12)

No comments that describe what code does — only why (non-obvious invariants, workarounds)

## Commands

```bash
npm run dev               # DEV app config; does NOT auto-apply migrations
npm run dev:prod-preview  # PROD app config, read-only preview of the deployed build
npm run typecheck         # react-router typegen + tsc
npm run lint
npm test                  # vitest: test/**/*.test.{ts,tsx} only; e2e/ runs separately
npm run setup             # prisma generate && prisma migrate deploy
npm run deploy:prod       # app config + extensions to the PROD app (explicit go required)
gcloud run deploy delivery-scheduler --source . --region us-central1 --project lalamove-map --service-account delivery-scheduler@lalamove-map.iam.gserviceaccount.com   # backend (explicit go required)
```

After creating or pulling a Prisma migration, state that `npm run setup` must run before the next `npm run dev`.

The container runs `npm run setup` (`prisma migrate deploy`) on every start, so a migration in the image is applied to `production` by the deploy itself. `migrate deploy` ignores migrations recorded in `_prisma_migrations` whose folders were deleted.

`.github/workflows/deploy.yml` authenticates as `github-deployer@lalamove-map.iam.gserviceaccount.com`; it failed on 2026-09-26 because that account had been deleted. The merchant deploys with the `gcloud` command above.

Neon project `delivery-scheduler` (Free plan) has one branch, `production`. The `dev` branch was deleted on 2026-09-25, so there is no dev database until a new one is branched from `production`. Only Cloud Run reaches `production`. Neon "block public connections" must stay off: Cloud Run connects over the public internet, and turning it on took the app down on 2026-09-25.

## Current shape (merchant decisions, 2026-09-25 unless noted)

- Every endpoint is verified by Shopify: webhook HMAC, app-proxy signature, or session token. There are no internal endpoints with their own secrets, no pollers, no Cloud Tasks, and no Cloud Scheduler jobs. Merchant: "dapat ang mga verification ay ang external logical na may shopify-Hmac at hindi ang internal logic."
- `orders/create` writes the delivery metafields, the schedule tag, and the COD fee line item inline, and answers 500 on a failed step so Shopify redelivers.
- Postgres (`neondb`) holds only `Session`, `DeliveryScheduleConfig`, `EmailSendLog`, and `_prisma_migrations`.
- Removed on merchant request: Lalamove tracking (poll, webhook, Order ID field, table), the delivery-sync queue and hourly sweep, bulk-action jobs, and the COD Settings page. Bulk actions run inline, 10 orders at most.
- The COD fee is Shopify-owned: the `COD-FEE` SKU product and its metafields. The app only adds the line item to COD orders. There is no lock against a double fee from overlapping webhook deliveries; merchant: add one only after an incident ("tsaka na lang lagyan kung may nangyari ng insidente").
- Orders page "Today" view auto-refreshes every 60 minutes.
- The `flowercart_marketing` database on `production` stays, for safe storage with no access by anyone else. It is written from outside this repo. Do not modify or delete it.
- Before any deploy, push to `main`, or database write, show the exact command or change and wait for the merchant (2026-09-26: "ipakita mo muna saakin yung exact command").

## Rules

Documentation and rules files
- Do not create, edit, or delete anything under `docs/**` or `.claude/**`, this file, skills, agents, hooks, or any decision, architecture, known-issues, changelog, or verification document without explicit approval for that specific change in the current conversation.
- Do not update documentation automatically after code changes. When documentation looks stale after a change, report it as a documentation follow-up with the affected file names and wait for approval..

Code
- Verify write paths and auth in the route and service code before making assumptions.
- Comments explain non-obvious behavior or implementation details only. No decisions, rationale, policy, TODOs, instructions, or commentary in code comments.
- Before ending a session, list every non-code file created or modified (markdown, JSON config, env examples, migrations, skills) with the reason for each.

Database
- No session connects to any Neon branch (`production` or `dev`) — not with `pg`, `psql`, `prisma studio`, `prisma db execute`, a script, or an MCP tool — without the merchant's permission in the current conversation AND a stated purpose for that specific access. "Explore", "audit", or "verify" on its own is not a purpose and not a standing grant; a session with no current purpose does not open the database.
- When granted, the default is read-only (`SET default_transaction_read_only = on`). A write (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`) needs the exact SQL shown first and a separate "go" for that statement.
- Never read, copy, or create a file that holds `production` credentials inside the repo folder (`.env.bak*`, `.env.prod*`, scripts with a connection string). Production URLs live only in Cloud Run Secret Manager.

## Hard rules

- Walang magbabalik ng mga deleted na documentation. Mga file:
  - `CHANGELOG.md`
  - `_archive/root/implementation_plan.md`
  - `docs/`
  - `docs/changelog.md`
  - `docs/customer-account-reschedule-validation-test-cases.md`
  - `docs/customer-email-design.md`
  - `docs/email-templates/README.md`
  - `docs/orders-ops-v2-audit.md`
  - `docs/orders-ops-v2-ux.md`
  - `docs/proposals/orders-refactor-vs-rebuild.md`
  - `docs/scheduler-v2-ux.md`
  - `docs/shopify-feature-research-context.md`
  - `docs/shopify-feature-research-findings.md`
  - `docs/superpowers/plans/2026-07-02-theme-storefront-api-direct-migration.md`
  - `docs/verification-log.md`
  - `extensions/cod-fee-notice/README.md`
  - `extensions/delivery-date-editor/README.md`
