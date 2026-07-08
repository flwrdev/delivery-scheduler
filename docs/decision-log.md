# Decision Log

Why things are the way they are. Architectural decisions, migrations, and investigation findings — not current-state documentation (see [architecture.md](architecture.md) for that, including its own dated verification log).

---

**Date:** 2026-07-02

**Decision:** Removed `app/routes/apps.schedule-rules.products.ts`'s dependency on session storage (Neon/Prisma) by (1) verifying the App Proxy `signature` manually instead of calling `authenticate.public.appProxy`, via a new helper `app/lib/verify-app-proxy.server.ts`, and (2) calling the Storefront API directly instead of the Admin API.

**Reason:** This route (unrelated to delivery scheduling — it paginates collection products for the theme's homepage "Show more" button) had a 4-7 second delay on the first click of the day; subsequent clicks were fast. Root cause: a double cold start. Cloud Run scales to zero (`--min-instances 0`) and Neon Free Postgres auto-suspends when idle; `authenticate.public.appProxy()` always resolves an offline session from Prisma/Neon session storage before handing back either an `admin` or `storefront` client — even though this route never needed a merchant session, only public catalog data.

**Investigation findings** (confirmed against Shopify's current docs via the dev-docs MCP tool and `validate_graphql_codeblocks`, not assumed from training data):
- App Proxy signature algorithm: HMAC-SHA256 hex digest over the query params (excluding `signature`), sorted by key, multi-value params joined with `,`, concatenated with **no separator** between pairs (not `&` — Shopify's own reference implementation does a plain `.join` with no delimiter), keyed with the app's shared secret. That secret is the same `SHOPIFY_API_SECRET` this app already uses elsewhere (`app/shopify.server.js`) — no new secret needed for signature verification itself.
- Storefront API's `Product.availableForSale` is a direct top-level Boolean field — no need to derive it from `tracksInventory`/`totalInventory` the way the Admin API version required.
- Storefront's `Product.compareAtPriceRange` reuses the *same* `ProductPriceRange` type as `priceRange` (both expose `.minVariantPrice`), unlike Admin's separate `ProductCompareAtPriceRange.minVariantCompareAtPrice` — a simpler mapping than the original Admin-based code.
- The Storefront API is inherently scoped to what's published/purchasable on the calling sales channel — draft/archived/unpublished products are excluded automatically. The old manual `isBuyable()` filter (`status === "ACTIVE"` + inventory check) was therefore deleted, not just simplified — it's genuinely redundant against this API.

**Trade-offs:** No change to the response contract — `{ products, nextCursor, hasNextPage }` and each product's shape are unchanged, so the theme's `collection-show-more` custom element (in the separate `live-theme-clean` repo) needed zero changes. Requires one new manual setup step: a **private** Storefront Access Token (`SHOPIFY_STOREFRONT_ACCESS_TOKEN`), created via Shopify Admin → Develop apps, configured in `.env` and the Cloud Run secret (done — confirmed by user). No fallback to the old Admin API path — if the token is ever missing, the route returns `502` rather than silently degrading.

**Incident note:** While verifying the token's env var was wired correctly, its value was inadvertently echoed into a terminal/tool-output transcript (a `grep` against `.env` that matched the whole line, value included). The user is rotating the token as a precaution. Not a code defect — a process reminder: when checking that an env var is *set*, check the key only, never `grep`/`cat` a `.env` file's values into a transcript.

**Verification:** `npm run typecheck` and `npm run lint` clean on all touched/added files. `npm test` — added `test/verify-app-proxy.server.test.ts` (8 cases: valid signature, multi-value params, wrong secret, tampered param, missing signature, non-hex signature, stale timestamp, future timestamp) — 31/31 total tests green (23 pre-existing + 8 new).

**Scope note:** This still leaves a plain Cloud Run container cold start possible on the first hit of the day (just not the compounded Neon+Cloud Run one). The stronger long-term fix — the theme calling the Storefront API directly from the browser, bypassing this backend entirely — was scoped and deferred to a separate task ("Option B"). See [`docs/superpowers/plans/2026-07-02-theme-storefront-api-direct-migration.md`](superpowers/plans/2026-07-02-theme-storefront-api-direct-migration.md) for the prepared implementation prompt — **that work happens in the separate `live-theme-clean` theme repo, not here.**

**Status:** Live. `SHOPIFY_STOREFRONT_ACCESS_TOKEN` configured in both local `.env` and the Cloud Run secret.

---

**Date:** 2026-07-02

**Decision:** Added `!.env.example` to `.gitignore` after the existing `.env.*` line.

**Reason:** The broad `.env.*` pattern was silently also matching `.env.example` — an onboarding/template file meant to be tracked, not a real secret — so edits to it were invisible to `git status`/diffs despite the file existing on disk. Confirmed via `git check-ignore -v .env.example`.

**Status:** Done.
