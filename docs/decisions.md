# Architecture Decision Records (ADRs)

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Why things are the way they are — deliberate tradeoffs distilled from the [verification log](./verification-log.md). Each ADR cites its source verification-log date. For current-state topology see [architecture.md](./architecture.md); for the route/write-path contract see [api.md](./api.md).

> ADR-6 and ADR-7 were migrated here from the former `docs/decision-log.md` (removed during the 2026-07-04 docs restructuring — its content was relocated, not deleted). They retain more of their original prose because they were already written in a decision-record style.

---

## ADR-1 — Delegate courier dispatch to the official Shopify Lalamove app

**Source:** verification log 2026-07-04.

**Context:** The app previously carried a bespoke Lalamove integration (`lalamove.*` metafields, a `webhooks.lalamove.ts` callback, an `orders/cancelled` webhook, `app/lib/lalamove.server.ts`, and in-drawer dispatch/quote UI). The store now has the official Shopify Lalamove app installed, which duplicates and supersedes that functionality.

**Decision:** Remove the custom Lalamove integration entirely and let the official Shopify Lalamove app handle all last-mile courier booking. This app now does delivery-date/time-slot **scheduling only**.

**Consequence:** No `lalamove.*` metafields, no custom dispatch UI, no Lalamove callback webhook, and no `orders/cancelled` webhook remain. Do **not** reintroduce any of them — coordinate courier work through the official app instead. Access scopes (`read/write_fulfillments` etc.) were deliberately left intact because the manual `markFulfilled` bulk action still uses them; removing them would force merchant re-consent.

---

## ADR-2 — Verify the App Proxy signature manually on the products route

**Source:** verification log 2026-07-02.

**Context:** `apps.schedule-rules.products.ts` paginates collection products for the theme's "Show more" button — public catalog data that never needs a merchant session. Calling `authenticate.public.appProxy` always resolves an offline session from Prisma/Neon (per Shopify's own docs), which — combined with Cloud Run scale-to-zero + Neon Free auto-suspend — caused a double cold-start on the first hit of the day.

**Decision:** Verify the App Proxy `signature` by hand via `app/lib/verify-app-proxy.server.ts` (`verifyAppProxySignature` — HMAC-SHA256 over sorted `key=value` query params excluding `signature`, keyed with the existing `SHOPIFY_API_SECRET`, plus a 5-minute timestamp freshness check) instead of calling `authenticate.public.appProxy`.

**Consequence:** No Prisma/Neon session lookup on this route, so no compounded Neon+Cloud Run cold start. This is the **only** App Proxy route that does not call `authenticate.public.appProxy` — every other one still does and must. No new secret is needed; the same `SHOPIFY_API_SECRET` signs the proxy request.

---

## ADR-3 — Call the Storefront API directly (not Admin) on the products route

**Source:** verification log 2026-07-02.

**Context:** The same products route originally hit the Admin API and derived `availableForSale` manually via an `isBuyable()` check (`status === "ACTIVE"` + `tracksInventory`/`totalInventory`). The Admin API path is heavier than needed for public catalog data.

**Decision:** Call the **Storefront API** directly via `fetch` with a private access token (`SHOPIFY_STOREFRONT_ACCESS_TOKEN`), and read `availableForSale` directly off the Storefront `Product` object.

**Consequence:** The manual `isBuyable()` filter was deleted (not just simplified) — the Storefront API only ever returns products published + purchasable on the calling sales channel, so it is genuinely redundant. The response contract (`{ products, nextCursor, hasNextPage }`) is unchanged. Requires a one-time manual setup of `SHOPIFY_STOREFRONT_ACCESS_TOKEN` in both `.env` and the Cloud Run secret (see `docs/cloud-run-neon.md` §6). No fallback to Admin — if the token is unset the route returns `502`.

---

## ADR-4 — Centralize `RESCHEDULED_ORDER_TAG` in `app/lib/constants.ts`

**Source:** verification log 2026-06-07.

**Context:** The reschedule-lock tag `"resched"` was duplicated as a raw string literal in both reschedule routes (`apps.schedule-rules.reschedule.ts` and `public.customer-account.reschedule.ts`). A divergent literal in one place would silently break the single-online-reschedule lock.

**Decision:** Export `RESCHEDULED_ORDER_TAG` from `app/lib/constants.ts` and import it in both reschedule routes.

**Consequence:** One source of truth for the lock primitive. Do not reintroduce the `= "resched"` literal per route. This is the repo's one evidenced "single-source shared constants instead of duplicating literals" convention (see [development.md](./development.md#coding-conventions--not-yet-documented)).

---

## ADR-5 — Coordinate sanitization for Lalamove pickup coords *(historical/void — do not follow as active guidance)*

**Source:** verification log 2026-06-07.

**Context:** When the custom Lalamove integration was live, `sanitizeCoordinate` (plain-decimal, range-checked, 6dp) was added to normalize sender pickup coordinates before sending them to the Lalamove API.

**Decision (now void):** Sanitize coordinates to 6 decimal places with range checks before dispatch.

**Consequence:** ⚠️ **The underlying feature was REMOVED 2026-07-04 (see ADR-1).** This ADR exists **only** to stop someone from reintroducing coordinate-sanitization code for a dead feature. It is **not** a pattern to reuse elsewhere — there is no live coordinate handling in this app anymore.

---

## ADR-6 — Remove the products route's session-storage dependency

**Source:** former `docs/decision-log.md` entry dated 2026-07-02 (migrated here).

**Context:** The `/apps/schedule-rules/products` route (unrelated to delivery scheduling — it paginates collection products for the theme's homepage "Show more" button) had a 4–7 second delay on the first click of the day; subsequent clicks were fast. Root cause: a double cold start. Cloud Run scales to zero (`--min-instances 0`) and Neon Free Postgres auto-suspends when idle; `authenticate.public.appProxy()` always resolves an offline session from Prisma/Neon session storage before handing back either an `admin` or `storefront` client — even though this route never needed a merchant session, only public catalog data.

**Decision:** Removed the route's dependency on session storage (Neon/Prisma) by (1) verifying the App Proxy `signature` manually instead of calling `authenticate.public.appProxy`, via a new helper `app/lib/verify-app-proxy.server.ts`, and (2) calling the Storefront API directly instead of the Admin API. *(This is the same change captured at a design-decision altitude by ADR-2 and ADR-3 above.)*

**Investigation findings** (confirmed against Shopify's current docs via the dev-docs MCP tool and `validate_graphql_codeblocks`, not assumed from training data):
- App Proxy signature algorithm: HMAC-SHA256 hex digest over the query params (excluding `signature`), sorted by key, multi-value params joined with `,`, concatenated with **no separator** between pairs (not `&` — Shopify's own reference implementation does a plain `.join` with no delimiter), keyed with the app's shared secret. That secret is the same `SHOPIFY_API_SECRET` this app already uses elsewhere (`app/shopify.server.js`) — no new secret needed for signature verification itself.
- Storefront API's `Product.availableForSale` is a direct top-level Boolean field — no need to derive it from `tracksInventory`/`totalInventory` the way the Admin API version required.
- Storefront's `Product.compareAtPriceRange` reuses the *same* `ProductPriceRange` type as `priceRange` (both expose `.minVariantPrice`), unlike Admin's separate `ProductCompareAtPriceRange.minVariantCompareAtPrice` — a simpler mapping than the original Admin-based code.
- The Storefront API is inherently scoped to what's published/purchasable on the calling sales channel — draft/archived/unpublished products are excluded automatically. The old manual `isBuyable()` filter (`status === "ACTIVE"` + inventory check) was therefore deleted, not just simplified — it's genuinely redundant against this API.

**Trade-offs:** No change to the response contract — `{ products, nextCursor, hasNextPage }` and each product's shape are unchanged, so the theme's `collection-show-more` custom element (in the separate `live-theme-clean` repo) needed zero changes. Requires one new manual setup step: a **private** Storefront Access Token (`SHOPIFY_STOREFRONT_ACCESS_TOKEN`), created via Shopify Admin → Develop apps, configured in `.env` and the Cloud Run secret. No fallback to the old Admin API path — if the token is ever missing, the route returns `502` rather than silently degrading.

**Incident note:** While verifying the token's env var was wired correctly, its value was inadvertently echoed into a terminal/tool-output transcript (a `grep` against `.env` that matched the whole line, value included). The user is rotating the token as a precaution. Not a code defect — a process reminder: when checking that an env var is *set*, check the key only, never `grep`/`cat` a `.env` file's values into a transcript.

**Verification:** `npm run typecheck` and `npm run lint` clean on all touched/added files. `npm test` — added `test/verify-app-proxy.server.test.ts` (8 cases) — 31/31 total tests green (23 pre-existing + 8 new).

**Scope note:** This still leaves a plain Cloud Run container cold start possible on the first hit of the day (just not the compounded Neon+Cloud Run one). The stronger long-term fix — the theme calling the Storefront API directly from the browser, bypassing this backend entirely — was scoped and deferred to a separate task ("Option B"). See [`docs/superpowers/plans/2026-07-02-theme-storefront-api-direct-migration.md`](superpowers/plans/2026-07-02-theme-storefront-api-direct-migration.md) for the prepared implementation prompt — **that work happens in the separate `live-theme-clean` theme repo, not here.**

**Status:** Live. `SHOPIFY_STOREFRONT_ACCESS_TOKEN` configured in both local `.env` and the Cloud Run secret.

---

## ADR-7 — Un-ignore `.env.example` so the template file is tracked

**Source:** former `docs/decision-log.md` entry dated 2026-07-02 (migrated here).

**Context:** The broad `.env.*` pattern in `.gitignore` was silently also matching `.env.example` — an onboarding/template file meant to be tracked, not a real secret — so edits to it were invisible to `git status`/diffs despite the file existing on disk. Confirmed via `git check-ignore -v .env.example`.

**Decision:** Added `!.env.example` to `.gitignore` after the existing `.env.*` line.

**Status:** Done.
