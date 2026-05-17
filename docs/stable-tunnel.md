# Stable Cloudflare tunnel

This app is configured to use the stable hostname `delivery-app.flowercart.store`.

## One-time setup

1. Authenticate this machine with Cloudflare:

   ```powershell
   cloudflared tunnel login
   ```

2. Create the named tunnel:

   ```powershell
   cloudflared tunnel create delivery-scheduler-dev
   ```

3. Route the stable hostname to the tunnel:

   ```powershell
   cloudflared tunnel route dns delivery-scheduler-dev delivery-app.flowercart.store
   ```

4. Create `%USERPROFILE%\.cloudflared\config.yml` with the tunnel ID returned from step 2:

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: C:\Users\janbr\.cloudflared\<tunnel-id>.json

   ingress:
     - hostname: delivery-app.flowercart.store
       service: http://localhost:3000
     - service: http_status:404
   ```

## Daily use

1. Start the named tunnel:

   ```powershell
   cloudflared tunnel run delivery-scheduler-dev
   ```

2. In the app repo, start Shopify dev against the stable hostname:

   ```powershell
   npm run dev:stable
   ```

3. If you change app URLs or scopes in `shopify.app.toml`, deploy the app config:

   ```powershell
   npm run deploy -- --allow-updates
   ```

## Notes

- `npm run dev:stable` uses `shopify app dev --no-update --tunnel-url=https://delivery-app.flowercart.store:3000`.
- The stable hostname must already resolve through the named tunnel before running the Shopify dev command.
- `shopify.app.toml` now uses the same stable hostname for `application_url`, auth callback allowlist, and the app proxy URL.
