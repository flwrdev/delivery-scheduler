# Development setup

How to run the app on your own machine with your own Shopify dev store. Nothing here touches the production app, the production database or Google Cloud.

## 1. Tools

| Tool | Version | Why |
|---|---|---|
| Node.js | 22.12 or newer (`engines` in `package.json`; the Docker image uses 22.23) | runs everything |
| npm | the one that comes with Node | the repo uses npm workspaces and `package-lock.json`; do not use yarn or pnpm |
| Shopify CLI | latest (`npm install -g @shopify/cli`) | `shopify app dev`, extension builds, the COD function test |
| PostgreSQL | any recent version (local, Docker or a free Neon project) | sessions, schedule rules, email log |
| Git | any | |

Optional: Docker (to build the production image locally), the Google Cloud SDK (maintainer only).

## 2. Install

```bash
npm install          # installs the root app and every extensions/* workspace
```

## 3. What works with no accounts at all

These need no Shopify app, no database and no network:

```bash
npm test                 # 39 unit test files under test/
npm run test:extensions  # extension render tests under extensions/*/tests (not cod-eligibility)
npm run lint
npm run typecheck        # react-router typegen, then tsc for the app and the extension tests
npm run build
```

`typecheck` and `build` need the Prisma client. Generate it once with a placeholder URL (no connection is made):

```bash
DIRECT_DATABASE_URL=postgresql://x:x@localhost:5432/x DATABASE_URL=postgresql://x:x@localhost:5432/x npx prisma generate
```

The client is written to `app/generated/prisma` (gitignored).

## 4. Your own Shopify dev app

`npm run dev` is wired to `shopify.app.production.toml`, the production app. You will not have access to it, so the CLI will refuse. Use your own app instead:

1. Create a free Shopify Partner or Dev Dashboard account and a development store.
2. In the repo folder run `npm run config:link` and choose **Create a new app**. The CLI writes `shopify.app.<your-name>.toml`. **Do not commit that file.**
3. Copy the `[access_scopes]`, `[webhooks]` and `[app_proxy]` blocks from `shopify.app.production.toml` into your toml so the routes behave the same.
4. Run the app with your config:

```bash
npx shopify app dev --config shopify.app.<your-name>.toml
```

The CLI opens a tunnel, sets `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` and `SCOPES` for the dev server, and installs the app on your dev store.

Things that live outside this repo, so your dev store will not have them unless you create them:
- the theme's delivery date picker (the theme calls the app proxy, see [architecture.md](architecture.md));
- order metafield definitions `custom.date` and `custom.time_slot`;
- the `COD-FEE` product used for the cash on delivery fee.

The app is configured as a single-merchant app (`AppDistribution.SingleMerchant` in `app/shopify.server.js`). Set `SHOP_DOMAIN` to your dev store domain.

## 5. Database

Prisma reads two URLs:

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | the running app (`app/db.server.js`, `pg` adapter) | can be a pooled URL |
| `DIRECT_DATABASE_URL` | Prisma CLI (`prisma.config.ts`): `migrate`, `generate` | must be a direct, non-pooled URL |

Apply the existing migrations to your own database:

```bash
npm run setup     # prisma generate && prisma migrate deploy
```

Rules:
- **Never point either URL at the production database.** Use a local Postgres, a Docker container, or your own Neon project or branch.
- `npm run dev` does not apply migrations. After you pull a new migration, run `npm run setup` again.
- To change the schema, edit `prisma/schema.prisma` and run `npx prisma migrate dev --name <short_name>` against a **local** database (it needs to create a temporary shadow database). Commit the new folder under `prisma/migrations`.
- Do not edit or delete a migration folder that is already on `main`. Production has already applied it.

Quick local Postgres with Docker:

```bash
docker run --name ds-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16
# DATABASE_URL and DIRECT_DATABASE_URL = postgresql://postgres:dev@localhost:5432/postgres
```

## 6. Environment variables

Copy `.env.example` to `.env`. `.env` is gitignored. Never commit real values.

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | yes | see above |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | yes | set for you by `shopify app dev`; needed by hand only outside the CLI |
| `SHOP_DOMAIN` | yes | the one shop the app serves, for example `your-dev-store.myshopify.com` |
| `SHOP_CUSTOM_DOMAIN` | no | the store's own domain, if it has one |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | no | only for `/apps/schedule-rules/products` (collection paging) |
| `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD`, `EMAIL_FROM_NAME` | no | customer email send; without them the send returns a "not configured" error |
| `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT` | no | inbox read; default to the SMTP host and port 993, and reuse the SMTP user and password |
| `GOOGLE_MAPS_API_KEY` | no | address search in the edit-details modal (browser only) |
| `META_PAGE_ID` | no | link to the Facebook page on the Orders page (`MESSENGER_PAGE_ID` is the older name) |
| `NODE_ENV` | no | `development` locally |

`MESSENGER_SHOP` and `LALAMOVE_SHOP` are older names for `SHOP_DOMAIN` and still work as fallbacks (`app/lib/shop-domain.server.ts`).

## 7. Tooling reference

| Tool | Config file | Notes |
|---|---|---|
| TypeScript 5.9 | `tsconfig.json`, `tsconfig.extension-tests.json`, per-extension `tsconfig.json` | `strict` on. `allowJs` on: some older files are `.js`/`.jsx`; new files should be `.ts`/`.tsx` |
| ESLint 8 | `.eslintrc.cjs`, `.eslintignore` | `eslint:recommended` plus `@typescript-eslint/parser`. No React or import plugins. `npm run lint` |
| Formatting | `.editorconfig` | 2 spaces, UTF-8, final newline. Prettier is **not** installed; `.prettierignore` is a leftover. Match the style of the file you edit |
| Vite 7 | `vite.config.js` | dev server and build through the React Router plugin |
| Vitest 4 | `vitest.config.ts` | unit tests, Node environment; a file can opt into jsdom with `// @vitest-environment jsdom` |
| Vitest 4 | `vitest.extensions.config.ts` | extension tests with `@shopify/ui-extensions-tester` and jsdom; uses Preact JSX |
| Vitest 3 | `extensions/cod-eligibility` | the Shopify Function test; it builds the function to WebAssembly, so it needs the Shopify CLI on your PATH. Run it with `npm test --workspace cod-eligibility -- --run` |
| Playwright | `e2e/playwright.config.ts` | API-level test against a real store, see [e2e/README.md](../e2e/README.md). Not part of normal checks |
| Prisma 7 | `prisma.config.ts`, `prisma/schema.prisma` | client output `app/generated/prisma` |
| GraphQL codegen | `.graphqlrc.js` | `npm run graphql-codegen`. Note: it still targets Admin API `October25` while the app uses `2026-04` (`ApiVersion.April26`) |
| Dependabot | `.github/dependabot.yml` | security update PRs only |

There is no CI. Run the checks in section 3 yourself before opening a pull request.

## 8. Docker image (optional)

```bash
docker build -t delivery-scheduler .
```

The image builds the app, then the start command runs `prisma migrate deploy` before the server. **Running the image applies migrations to whatever database `DIRECT_DATABASE_URL` points at**, so only run it against your own database. The server listens on `PORT` (Cloud Run sets 8080; the Dockerfile `EXPOSE 3000` is informational).
