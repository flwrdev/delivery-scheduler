# Cloud Run + Neon Free

This is the recommended low-cost hosted path for this app if you want a stable backend URL without transferring nameservers.

## Why this setup

- Cloud Run can stay within the free tier for a low-traffic Shopify app if `min instances` stays at `0`.
- Neon Free provides enough Postgres capacity for small apps and scales to zero when idle.
- You can use the default Google `run.app` hostname first, so there is no DNS or nameserver work required.

## Expected cost profile

- Cloud Run: often `$0` at small traffic levels, subject to Google free-tier limits.
- Neon Free: `$0` while you remain within the free-plan limits.
- Cloud SQL: not recommended for the free path because it becomes a fixed monthly cost.

## 1. Create a Neon database

1. Create a Neon project.
2. Copy the pooled connection string into `DATABASE_URL`.
3. Copy the direct connection string into `DIRECT_DATABASE_URL`.
4. Make sure both URLs include `sslmode=require`.

## 2. Configure local environment

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `DATABASE_URL`
   - `DIRECT_DATABASE_URL`
   - `SHOPIFY_API_KEY`
   - `SHOPIFY_API_SECRET`
   - `SCOPES`

You can leave `SHOPIFY_APP_URL` as a placeholder locally if Shopify CLI is injecting the app URL during `shopify app dev`.

## 3. Apply the Prisma schema to Neon

Run:

```powershell
npm exec prisma generate
npm exec prisma migrate deploy
```

This repository's migrations are now PostgreSQL-compatible and are intended to be applied to a fresh Postgres database.

## 4. Deploy the app to Cloud Run

Enable the required APIs:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

Create secrets for the sensitive values:

```powershell
gcloud secrets create delivery-scheduler-database-url --replication-policy=automatic
gcloud secrets create delivery-scheduler-direct-database-url --replication-policy=automatic
gcloud secrets create delivery-scheduler-shopify-api-secret --replication-policy=automatic
```

Add secret versions:

```powershell
$databaseUrlFile = Join-Path $env:TEMP "delivery-scheduler-database-url.txt"
$directDatabaseUrlFile = Join-Path $env:TEMP "delivery-scheduler-direct-database-url.txt"
$shopifyApiSecretFile = Join-Path $env:TEMP "delivery-scheduler-shopify-api-secret.txt"

[System.IO.File]::WriteAllText($databaseUrlFile, "PASTE_DATABASE_URL")
[System.IO.File]::WriteAllText($directDatabaseUrlFile, "PASTE_DIRECT_DATABASE_URL")
[System.IO.File]::WriteAllText($shopifyApiSecretFile, "PASTE_SHOPIFY_API_SECRET", [System.Text.Encoding]::ASCII)

gcloud secrets versions add delivery-scheduler-database-url --data-file=$databaseUrlFile
gcloud secrets versions add delivery-scheduler-direct-database-url --data-file=$directDatabaseUrlFile
gcloud secrets versions add delivery-scheduler-shopify-api-secret --data-file=$shopifyApiSecretFile

Remove-Item $databaseUrlFile, $directDatabaseUrlFile, $shopifyApiSecretFile
```

Do not add a trailing newline to `SHOPIFY_API_SECRET`. A trailing `CRLF` changes the secret bytes and causes Shopify session-token signature verification to fail.

First deploy the service without a final `SHOPIFY_APP_URL`, so Google assigns the default `run.app` URL:

```powershell
gcloud run deploy delivery-scheduler ^
  --source . ^
  --region us-central1 ^
  --allow-unauthenticated ^
  --min-instances 0 ^
  --max-instances 2 ^
  --cpu 1 ^
  --memory 512Mi ^
  --concurrency 20 ^
  --set-env-vars NODE_ENV=production,SCOPES=read_orders,write_orders,read_customers,write_products,read_metaobjects,write_metaobjects,write_metaobject_definitions,SHOPIFY_API_KEY=REPLACE_ME ^
  --set-secrets DATABASE_URL=delivery-scheduler-database-url:latest,DIRECT_DATABASE_URL=delivery-scheduler-direct-database-url:latest,SHOPIFY_API_SECRET=delivery-scheduler-shopify-api-secret:latest
```

## 5. Capture the Cloud Run URL and finish Shopify config

Read the generated service URL:

```powershell
gcloud run services describe delivery-scheduler --region us-central1 --format="value(status.url)"
```

Update the Cloud Run service with the actual public URL:

```powershell
gcloud run services update delivery-scheduler --region us-central1 --update-env-vars SHOPIFY_APP_URL=https://YOUR_SERVICE_URL
```

Then update `shopify.app.toml` to use that same URL for:

- `application_url`
- `redirect_urls`
- `[app_proxy].url`

Finally sync the Shopify app config:

```powershell
npm run deploy -- --allow-updates
```

## 6. Storefront Access Token (for the `/apps/schedule-rules/products` route)

`app/routes/apps.schedule-rules.products.ts` calls the Storefront API directly
with a private access token instead of going through `authenticate.public.appProxy`
— this avoids a session-storage (Neon) round trip on every cold start, since
that route only serves public catalog data. Manual, one-time setup:

1. Shopify Admin → Settings → Apps → Develop apps → this app → API credentials
   → generate a Storefront API access token (or add the Headless sales channel).
2. Add it as a Cloud Run secret and env var, same pattern as `SHOPIFY_API_SECRET`:

```powershell
gcloud secrets create delivery-scheduler-storefront-token --replication-policy=automatic
$storefrontTokenFile = Join-Path $env:TEMP "delivery-scheduler-storefront-token.txt"
[System.IO.File]::WriteAllText($storefrontTokenFile, "PASTE_STOREFRONT_TOKEN", [System.Text.Encoding]::ASCII)
gcloud secrets versions add delivery-scheduler-storefront-token --data-file=$storefrontTokenFile
Remove-Item $storefrontTokenFile

gcloud run services update delivery-scheduler --region us-central1 `
  --update-secrets SHOPIFY_STOREFRONT_ACCESS_TOKEN=delivery-scheduler-storefront-token:latest
```

Until this is set, the route returns `502 Storefront API request failed` — it
does not fall back to the Admin API.

## 7. Keep costs down

- Leave Cloud Run `min instances` at `0`.
- Keep `max instances` low unless you see real traffic pressure.
- Keep the Neon database on the Free plan unless you outgrow it.
- Avoid Cloud SQL if the goal is to stay free.

## Notes

- The current Prisma configuration assumes PostgreSQL, not SQLite.
- Existing local SQLite data is not migrated automatically by these repo changes.
- If you later want a custom domain, you can add it after the `run.app` version is working.
