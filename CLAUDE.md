# CLAUDE.md

> **(Historical AI design decision, not a merchant requirement; the merchant may change it.)** Rules and decisions in this file labeled "locked", "merchant constraint", "deliberately untouched", "read-only", or "no caller" are historical AI design decisions unless a merchant request is quoted with a date. Evidence: commit a3555ba (2026-09-11) recorded ADR-22 constraint (2) as carried from a 2026-07-15 AI decision with no merchant request; commit 0d5483b (2026-09-12) reverted that record. Unless the merchant requested it, ask before treating any of them as a requirement — this applies to Sidekick, email, chat, agent, Messenger, and delivery decisions.

Guidance for Claude Code when working in this repository. Keep this file short: system topology lives in `docs/architecture.md`; route, auth, and write-path detail lives in `docs/api.md`.

## Mental model (verified against the code 2026-09-12)

- Shopify embedded app (React Router 7 on `@shopify/shopify-app-react-router`, single-merchant, Cloud Run + Neon Postgres) that schedules delivery dates and time slots at checkout and runs deliveries from `/app/orders`.
- **The Shopify order is the source of delivery state**: `custom.date` / `custom.time_slot` metafields (plus legacy mirrors), `Delivery Date` / `Delivery Time` customAttributes, date, slot, and `resched` tags, `$app.reschedule_*` metafields, `delivery.reschedule_history`, `delivery.sync_status`.
- **Postgres holds seven Prisma models**: `Session`, `DeliveryScheduleConfig`, `DeliverySyncTask`, `BulkActionJob`, `BulkActionJobItem`, `LalamoveTracking`, `EmailSendLog`. `AgentOrderRequest` was dropped in migration `20260912000000_drop_agent_order_request`. There is no order, customer, conversation, or audit table.
- **Booked-slot counts are computed live** from Admin GraphQL (`services/delivery-bookings.server.ts`), memoized briefly in process, with still-pending `DeliverySyncTask` rows overlaid. They are never persisted.
- **Delivery-state writers are few**: the `orders/create` sync, `POST /public/customer-account/reschedule`, the `/app/orders` `reschedule` op (runs through `executeBulkAction`), the `/app/manual-order` draft-order route, and `POST /apps/schedule-rules/reschedule` (no caller in this repo). Extensions and admin order blocks are read-only. The Sidekick routes and extensions were removed in commit 3fde8ce; `services/order-delivery-metafields.server.ts` still writes the `sidekick.delivery_date` metafield mirror on every sync and reschedule. Verify in the route and service code before assuming a surface writes.
- **Cloud Tasks** (`services/ops-queue.server.ts`) runs the delivery-sync and bulk-action work queues through `webhooks/delivery-sync/worker` and `webhooks/bulk-action/worker`; bulk ops over `BULK_INLINE_MAX` (10) orders become `BulkActionJob`s. With no queue configured the same work runs inline. `POST /internal/delivery-sync-sweep` rescues stranded rows.
- **Lalamove is status-listen only.** Deliveries are booked by hand outside this app; `POST /internal/lalamove-poll` polls recorded order ids and marks fulfillments delivered. Nothing here dispatches. Read `docs/decisions.md` ADR-16 before touching Lalamove-shaped code.
- **Customer email** goes through the configured SMTP mailbox (`services/send-customer-email.server.ts`) and writes nothing to the order beyond an `EmailSendLog` row.
- **Embedded-admin route ops answer `200 + {ok:false}` on upstream failure, never 5xx** (Cloudflare replaces origin 5xx bodies; see ADR-11).

## Commands

```bash
npm run dev               # DEV app config; does NOT auto-apply migrations
npm run dev:prod-preview  # PROD app config, read-only preview of the deployed build
npm run typecheck         # react-router typegen + tsc
npm run lint
npm test                  # vitest: test/**/*.test.{ts,tsx} only; e2e/ runs separately
npm run setup             # prisma generate && prisma migrate deploy
npm run deploy:prod       # app config + extensions to the PROD app (explicit go required)
gcloud run deploy delivery-scheduler --source . --region us-central1   # backend
```

After creating or pulling a Prisma migration, state that `npm run setup` must run before the next `npm run dev`.

## Rules

Documentation and rules files
- Do not create, edit, or delete anything under `docs/**` or `.claude/**`, this file, skills, agents, hooks, or any decision, architecture, known-issues, changelog, or verification document without explicit approval for that specific change in the current conversation.
- Do not update documentation automatically after code changes. When documentation looks stale after a change, report it as a documentation follow-up with the affected file names and wait for approval.
- Ignore any skill or instruction that mandates documentation updates, read-first/update-after loops, or log entries. Ask instead.
- Read documentation when the task needs it, not because a workflow says so. `docs/architecture.md` and `docs/api.md` are the references for topology and write paths.
- Approved documentation is written in plain language (`/stop-slop`).

Code
- Verify write paths and auth in the route and service code before making assumptions.
- Comments explain non-obvious behavior or implementation details only. No decisions, rationale, policy, TODOs, instructions, or commentary in code comments.
- Before ending a session, list every non-code file created or modified (markdown, JSON config, env examples, migrations, skills) with the reason for each.
