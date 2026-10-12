# delivery-scheduler

> **(Historical AI design decision, not a merchant requirement; the merchant may change it.)** Rules and decisions in this file labeled "locked", "merchant constraint", "deliberately untouched", "read-only", or "no caller" are historical AI design decisions unless a merchant request is quoted with a date. Evidence: commit a3555ba (2026-09-11) recorded ADR-22 constraint (2) as carried from a 2026-07-15 AI decision with no merchant request; commit 0d5483b (2026-09-12) reverted that record. Unless the merchant requested it, ask before treating any of them as a requirement — this applies to Sidekick, email, chat, agent, Messenger, and delivery decisions.

Shopify embedded app (React Router 7) for **The Flowercart** — adds
delivery-date / time-slot scheduling to checkout, syncs that state onto
Shopify orders, and gives the merchant an orders-operations workspace
(`/app/orders`: delivery-first order panel, merchant/customer reschedule,
bulk fulfillment ops, customer email with photo attachments).

**Production:** Google Cloud Run (`delivery-scheduler`, us-central1, project
`jhay-510919`) + Neon Postgres (sessions, the schedule settings and the email
send log — delivery state lives on the Shopify order itself).

Agent guidance and project rules live in [CLAUDE.md](CLAUDE.md).
How the app works: [docs/architecture.md](docs/architecture.md). Operations: [docs/runbook.md](docs/runbook.md). Google Cloud resources, principals and secret names: [docs/gcp-inventory.md](docs/gcp-inventory.md).

## Quick start

```bash
npm install
npm run setup             # prisma generate + migrate deploy (needs DIRECT_DATABASE_URL; read the database rules in CLAUDE.md first)
npm run dev               # shopify app dev with shopify.app.production.toml, the only app config
npm test                  # vitest (safe, no side effects)
npm run test:extensions   # extension tests
npm run typecheck && npm run lint && npm run build
```

## Production deploys

```bash
gcloud run deploy delivery-scheduler --source . --region us-central1 --project jhay-510919 --service-account delivery-scheduler-runtime@jhay-510919.iam.gserviceaccount.com   # backend
npm run deploy:prod   # app config + extensions (shopify app deploy --config shopify.app.production.toml)
```

`shopify.app.production.toml` is the only app config. The bare `npm run deploy`
is disabled; use `npm run deploy:prod`. Details are in [docs/runbook.md](docs/runbook.md).


