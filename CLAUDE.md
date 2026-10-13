# CLAUDE.md

> **(Historical AI design decision, not a merchant requirement; the merchant may change it.)** Rules and decisions in this file labeled "locked", "merchant constraint", "deliberately untouched", "read-only", or "no caller" are historical AI design decisions unless a merchant request is quoted with a date. Evidence: commit a3555ba (2026-09-11) recorded ADR-22 constraint (2) as carried from a 2026-07-15 AI decision with no merchant request; commit 0d5483b (2026-09-12) reverted that record. Unless the merchant requested it, ask before treating any of them as a requirement — this applies to Sidekick, email, chat, agent, Messenger, and delivery decisions.



## Commands

```bash
npm run dev               # shopify app dev with shopify.app.production.toml
npm run typecheck
npm run lint
npm test                  # vitest: test/**/*.test.{ts,tsx}
npm run test:extensions   # vitest: extensions/*/tests/**/*.test.{ts,tsx}
npm run deploy:prod       # app config + extensions to the PROD app (explicit go required)
```

There is no CI. As of 2026-10-07 Node and the Shopify CLI are not installed on the merchant's PC, so branch `migrate/shopify-app-home` has not been run or tested.

## Current shape (branch `migrate/shopify-app-home`, 2026-10-07)

- Admin UI: App Home extension `extensions/app-home` (`admin.app.home.render`, Preact, Polaris web components), hosted by Shopify. Pages: `/` Orders Operations, `/settings` Delivery Scheduler. Shopify access is `shopify.query` only.
- The extension imports the shared code in `app/lib` and `app/services`: `orders-view.ts`, `orders-bulk-op.ts`, `bulk-actions.ts`, `schedule-rules.server.ts`, `scheduler-ops.server.ts`. The old `/app/orders` route calls the same functions.
- Delivery settings: shop metafield `$app.delivery_schedule_rules` (json, same row shape as the old `DeliveryScheduleConfig` table plus `version` for compare-and-swap). The old values were lost with the Neon project.
- Planned server (not built), limited to these routes: `POST /webhooks/orders/create` (Shopify HMAC; adds the COD fee line to COD orders only; delivery tags and metafields are written by Shopify Flow) and four email endpoints called by the App Home: `GET /api/email/replies`, `GET /api/email/thread`, `POST /api/email/send`, `POST /api/email/reschedule-notice` (Shopify ID token verified on the server). No other routes, no admin UI, no app proxy, and no email content stored. Until it exists, COD orders get no COD fee line, and the Orders page shows "Couldn't reach the email server." Merchant: "dapat ang mga verification ay ang external logical na may shopify-Hmac at hindi ang internal logic." Merchant (2026-10-09): "ipagpatuloy ang original na plano na ang email at cod lang ang may server at function. hindi mababago walang makakapag pabago ng desisyon kung walang sapat na reason."
- Cloud Run service `delivery-scheduler` and Neon project `delivery-scheduler` were deleted. The React Router server code, Prisma and the Dockerfile stay in the repo until the migration removes them.
- Google Cloud still has (console, checked 2026-10-02): the Cloud Scheduler job `delivery-scheduler-keepwarm`, which pings the app every 10 minutes from 7am to 9pm Manila time; an empty Cloud Tasks queue, `messenger-events`, that no code in this repo uses; and a second Cloud Run service, `local`, created 2026-09-30, whose only revision failed to start.
- The schedule tags are the bare date and slot (`2026-10-03`, `9AM-12PM`). The app writes them on `orders/create` and on every reschedule. No Shopify Flow writes them: every delivery-tag workflow in Flow is inactive, and "Tag orders with delivery date and time" was turned off on 2026-05-01 (checked 2026-10-02). The Orders page date tabs and date filter search by these tags, and the merchant's Shopify Orders list, order email notifications and analytics use them. Merchant (2026-10-02): "kung babaguhin mo ang order tag ay pwede masira date picker logic kaya dahilan ng pa sulat pa ng app ng order tag" and "yung tag ginagamit ko sa automate sa ibang paraan … tulad ng mga order email notification at ibang analytics na sa order tag bumabase."
- Slot capacity limits are on only for Valentine's Day and Mother's Day. Merchant (2026-10-02): "no capacity yet and its intentional because the capacity is for valentine and mothersday only.. at hindi ito napupuno sa totoong buhay."
- Removed on merchant request: Lalamove tracking (poll, webhook, Order ID field, table), the delivery-sync queue and hourly sweep, bulk-action jobs, and the COD Settings page. Bulk actions run inline, 10 orders at most.
- The COD fee is Shopify-owned: the `COD-FEE` SKU product and its metafields. The app only adds the line item to COD orders. There is no lock against a double fee from overlapping webhook deliveries; merchant: add one only after an incident ("tsaka na lang lagyan kung may nangyari ng insidente").
- Orders page "Today" view auto-refreshes every 60 minutes.
- The Private Email mailbox is the source of truth for customer email; no sent or received email is stored in a database (no `EmailSendLog`, merchant 2026-10-08). Sending is plain text, one SMTP send per email with a BCC copy to the mailbox; photo attachments were removed on merchant request (2026-10-08) to reduce SMTP sends. Incoming email is read over IMAP, read-only, only during a request: Orders page load, Refresh, auto-refresh, opening the bell (at most once a minute), and opening an order's conversation. There is no IDLE connection and no poller. The bell shows the full reply text (quoted history stripped, up to 4000 characters) so cancellations and address changes are readable at a glance (merchant, 2026-10-08). IMAP reuses `EMAIL_SMTP_USER`/`EMAIL_SMTP_PASSWORD`; `EMAIL_IMAP_HOST` and `EMAIL_IMAP_PORT` are optional.
- Email state lives in Shopify metafields, not Postgres (merchant 2026-10-08: "yes metafield talaga yan"): `$app.email_reply_seen_at` (order metafield, date_time, written by the App Home through `shopify.query`) and `$app.quick_replies` (shop metafield, json, edited on the Delivery Scheduler page and inserted into the Reply modal).
- The `flowercart_marketing` database on `production` stays, for safe storage with no access by anyone else. It is written from outside this repo. Do not modify or delete it.
- Before any deploy, push to `main`, or database write, show the exact command or change and wait for the merchant (2026-09-26: "ipakita mo muna saakin yung exact command").

## Rules

Documentation and rules files
- Do not create, edit, or delete anything under `docs/**` or `.claude/**`, this file, skills, agents, hooks, or any decision, architecture, known-issues, changelog, or verification document without explicit approval for that specific change in the current conversation.
- Do not update documentation automatically after code changes. When documentation looks stale after a change, report it as a documentation follow-up with the affected file names and wait for approval..

Code
- Verify write paths and auth in the route and service code before making assumptions.
- Comments explain non-obvious behavior or implementation details only. No decisions, rationale, policy, TODOs, instructions, or commentary in code comments.
- Preserve the order tags and the order metafields and attributes the app writes now; never change them silently. Merchant (2026-10-07): "preserve the order tag and metafield attributes to the current app do not change silently".
- Before ending a session, list every non-code file created or modified (markdown, JSON config, env examples, migrations, skills) with the reason for each.

Database
- No session connects to any Neon branch (`production` or `dev`) — not with `pg`, `psql`, `prisma studio`, `prisma db execute`, a script, or an MCP tool — without the merchant's permission in the current conversation AND a stated purpose for that specific access. "Explore", "audit", or "verify" on its own is not a purpose and not a standing grant; a session with no current purpose does not open the database.
- When granted, the default is read-only (`SET default_transaction_read_only = on`). A write (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`TRUNCATE`) needs the exact SQL shown first and a separate "go" for that statement.
- Never read, copy, or create a file that holds `production` credentials inside the repo folder (`.env.bak*`, `.env.prod*`, scripts with a connection string). App secrets (`SHOPIFY_API_SECRET`, `EMAIL_SMTP_PASSWORD`, `DATABASE_URL`) live only in Google Secret Manager, mounted into Cloud Run (merchant 2026-10-08). No session reads, prints, or copies a secret value into the repo, chat, logs, commits, or tool output. Secrets are referred to by name only; the merchant enters the values, and a session shows commands with placeholders such as `<SMTP_PASSWORD>`.

