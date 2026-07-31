# delivery-scheduler

Shopify embedded app (React Router 7) for **The Flowercart** — adds
delivery-date / time-slot scheduling to checkout, syncs that state onto
Shopify orders, and gives the merchant an orders-operations workspace
(`/app/orders`: delivery-first order panel, merchant/customer reschedule,
bulk fulfillment ops, customer email with photo attachments).

**Production:** Google Cloud Run (`delivery-scheduler`, us-central1, project
`lalamove-map`) + Neon Postgres (sessions + schedule config only — delivery
state lives on the Shopify order itself).

## Documentation (start here)

| Doc | What it covers |
| --- | -------------- |
| [docs/architecture.md](docs/architecture.md) | System topology + data model — **source of truth** |
| [docs/api.md](docs/api.md) | Routes, auth mechanisms, order write-path contract |
| [docs/development.md](docs/development.md) | Commands, dev/testing workflow, deployment notes |
| [docs/known-issues.md](docs/known-issues.md) | Open issues / in-flight fixes |
| [docs/changelog.md](docs/changelog.md) | Newest-first history; details in [docs/verification-log.md](docs/verification-log.md) |
| [docs/decisions.md](docs/decisions.md) | ADRs (architecture decisions) |
| [docs/cloud-run-neon.md](docs/cloud-run-neon.md) | Hosting + secrets runbook |

Agent guidance lives in [CLAUDE.md](CLAUDE.md).

## Quick start

```bash
npm install
npm run setup      # prisma generate + migrate deploy (needs DATABASE_URL)
npm run dev        # shopify app dev (tunnel; see development.md for the dev-app config)
npm test           # vitest (safe, no side effects)
npm run typecheck && npm run lint && npm run build
```

## Production deploys

```bash
gcloud run deploy delivery-scheduler --source . --region us-central1   # backend
npm run deploy:prod                                                     # app config + extensions
```

⚠️ Never run the bare `shopify app deploy` / `npm run deploy` — always use
`npm run deploy:dev` or `npm run deploy:prod` explicitly. `shopify.app.toml` is
the DEV config (default), `shopify.app.production.toml` is PROD. Full runbook:
[docs/cloud-run-neon.md](docs/cloud-run-neon.md).
