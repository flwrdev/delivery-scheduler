# CLAUDE.md

> **(Historical AI design decision, not a merchant requirement; the merchant may change it.)** Rules and decisions in this file labeled "locked", "merchant constraint", "deliberately untouched", "read-only", or "no caller" are historical AI design decisions unless a merchant request is quoted with a date. Evidence: commit a3555ba (2026-09-11) recorded ADR-22 constraint (2) as carried from a 2026-07-15 AI decision with no merchant request; commit 0d5483b (2026-09-12) reverted that record. Unless the merchant requested it, ask before treating any of them as a requirement — this applies to Sidekick, email, chat, agent, Messenger, and delivery decisions.



## Mental model (verified against the code 2026-09-12)

No comments that describe what code does — only why (non-obvious invariants, workarounds)

## Commands

```bash
npm run dev               # shopify app dev with shopify.app.production.toml, the only app config; does NOT auto-apply migrations
npm run typecheck         # react-router typegen + tsc
npm run lint
npm test                  # vitest: test/**/*.test.{ts,tsx} only; e2e/ runs separately
npm run test:extensions   # vitest: extensions/*/tests/**/*.test.{ts,tsx}
npm run setup             # prisma generate && prisma migrate deploy
npm run deploy:prod       # app config + extensions to the PROD app (explicit go required)
gcloud run deploy delivery-scheduler --source . --region us-central1 --project lalamove-map --service-account delivery-scheduler@lalamove-map.iam.gserviceaccount.com   # backend (explicit go required)
```

After creating or pulling a Prisma migration, state that `npm run setup` must run before the next `npm run dev`.

The container runs `npm run setup` (`prisma generate && prisma migrate deploy`) on every start, so a migration in the image is applied to `production` by the deploy itself. `migrate deploy` ignores migrations recorded in `_prisma_migrations` whose folders were deleted.

There is no CI: `.github/workflows/` (`ci.yml`, `deploy.yml`) was deleted in commit 7f89d04. The merchant deploys with the `gcloud` command above. The `github-deployer@lalamove-map.iam.gserviceaccount.com` account is disabled, not deleted, and still holds deploy roles (Google Cloud console, checked 2026-10-02).

Neon project `delivery-scheduler` (Free plan) has one branch, `production`. The `dev` branch was deleted on 2026-09-25, so there is no dev database until a new one is branched from `production`. Only Cloud Run reaches `production`. Neon "block public connections" must stay off: Cloud Run connects over the public internet, and turning it on took the app down on 2026-09-25.

## Current shape (merchant decisions, 2026-09-25 unless noted)

- Every endpoint is verified by Shopify: webhook HMAC, app-proxy signature, or session token. There are no internal endpoints with their own secrets and no pollers. Merchant: "dapat ang mga verification ay ang external logical na may shopify-Hmac at hindi ang internal logic."
- Google Cloud still has (console, checked 2026-10-02): the Cloud Scheduler job `delivery-scheduler-keepwarm`, which pings the app every 10 minutes from 7am to 9pm Manila time; an empty Cloud Tasks queue, `messenger-events`, that no code in this repo uses; and a second Cloud Run service, `local`, created 2026-09-30, whose only revision failed to start.
- `orders/create` writes the delivery metafields, the schedule tags, and the COD fee line item inline, and answers 500 on a failed step so Shopify redelivers.
- The schedule tags are the bare date and slot (`2026-10-03`, `9AM-12PM`). The app writes them on `orders/create` and on every reschedule. No Shopify Flow writes them: every delivery-tag workflow in Flow is inactive, and "Tag orders with delivery date and time" was turned off on 2026-05-01 (checked 2026-10-02). The Orders page date tabs and date filter search by these tags, and the merchant's Shopify Orders list, order email notifications and analytics use them. Merchant (2026-10-02): "kung babaguhin mo ang order tag ay pwede masira date picker logic kaya dahilan ng pa sulat pa ng app ng order tag" and "yung tag ginagamit ko sa automate sa ibang paraan … tulad ng mga order email notification at ibang analytics na sa order tag bumabase."
- Slot capacity limits are on only for Valentine's Day and Mother's Day. Merchant (2026-10-02): "no capacity yet and its intentional because the capacity is for valentine and mothersday only.. at hindi ito napupuno sa totoong buhay."
- Postgres (`neondb`) holds only `Session`, `DeliveryScheduleConfig`, `EmailSendLog`, and `_prisma_migrations`.
- Removed on merchant request: Lalamove tracking (poll, webhook, Order ID field, table), the delivery-sync queue and hourly sweep, bulk-action jobs, and the COD Settings page. Bulk actions run inline, 10 orders at most.
- The COD fee is Shopify-owned: the `COD-FEE` SKU product and its metafields. The app only adds the line item to COD orders. There is no lock against a double fee from overlapping webhook deliveries; merchant: add one only after an incident ("tsaka na lang lagyan kung may nangyari ng insidente").
- Orders page "Today" view auto-refreshes every 60 minutes.
- Incoming customer email is read from the Private Email mailbox over IMAP, read-only, only during a request: Orders page load, Refresh, opening the bell, and opening an order panel. There is no IDLE connection and no poller. IMAP reuses `EMAIL_SMTP_USER`/`EMAIL_SMTP_PASSWORD`; `EMAIL_IMAP_HOST` and `EMAIL_IMAP_PORT` are optional.
- Email state lives in Shopify, not Postgres: `$app.email_reply_seen_at` (order metafield, date_time) and `$app.quick_replies` (shop metafield, json, edited on the Delivery Scheduler page).
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
