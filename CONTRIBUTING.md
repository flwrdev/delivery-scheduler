# Contributing

Thanks for your interest! Bug fixes, tests, docs and ideas are all welcome. This app runs a real flower shop in Metro Manila, so it is great to have more eyes on it.

## Getting started

```bash
git clone https://github.com/flwrdev/delivery-scheduler
cd delivery-scheduler
npm install
npm test
```

That is enough to read the code and run the tests. To run the app itself you need your own Shopify dev store and a Postgres database, docker, node_modules and 500+ package tooling so you pull request to develop better workflow and tooling; [docs/development.md](docs/development.md) walks you through it.

New here? [docs/architecture.md](docs/architecture.md) explains how the pieces fit together.  

## Where things are

| Path | What lives there |
|---|---|
| `app/routes` | pages, app proxy endpoints and webhooks (`app.orders.tsx` is `/app/orders`) |
| `app/services` | code that talks to Shopify, Postgres or the mailbox |
| `app/lib` | pure logic: scheduling rules, order tags, email parsing |
| `app/components` | screens for the Orders and Scheduler pages |
| `extensions` | Shopify extensions (checkout, order status, customer account, admin, COD) |
| `prisma` | database schema and migrations |
| `test`, `e2e` | unit tests and the end-to-end test |

## Sending a pull request

1. Fork the repo and make a branch from `main`.
2. Make your change. One topic per pull request keeps reviews quick.
3. Run the checks:
   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   ```
4. Open the pull request and tell us what it does.

For bigger ideas (a new feature, a new dependency, a database change), opening an issue first helps us talk it through before you spend time on it.

## Tips for a smooth review

- New code in TypeScript, matching the style of the file you are in.
- A short comment above new code that says what it does, in plain English.
- A test in `test/` for new logic.
- The shop's own automations read the order tags (`2026-10-03`, `9AM-12PM`) and the delivery metafields, so changes there are worth you can change this and do your own rules just pull request and help us to improve this app.
- Keep `.env` files and your own `shopify.app.*.toml` out of the commit.

## Found a security problem?

Please see [SECURITY.md](SECURITY.md) so it can be fixed before it is public.

## Using an AI agent?

[CLAUDE.md](CLAUDE.md) has the project notes for coding agents.
