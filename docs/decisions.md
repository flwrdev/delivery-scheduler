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

---

## ADR-8 — Refactor in place (not greenfield rebuild) for Order Operations V2

**Source:** [proposals/orders-refactor-vs-rebuild.md](./proposals/orders-refactor-vs-rebuild.md) (read-only audit, 2026-07-08).

**Context:** Order Operations V2 adds write paths the current `/app/orders` dashboard lacks (reschedule via `custom.date`/`custom.time_slot`/`reschedule_history`, mark COD paid), plus a Today-first view and keyboard-driven flow. The question was whether to refactor `app.orders.tsx` + `OrderDrawer.tsx` in place or rebuild in a new namespace reusing only shared utilities.

**Decision:** Refactor in place. Basis (from the audit): reusability scorecard of **64% keep-as-is / 34% salvage-with-rework / 2% delete** over 4,633 lines; `markFulfilled` is already implemented in the existing action handler (`app.orders.tsx:709–870`), proving the per-op pattern absorbs complex writes; and the reschedule domain services (`syncOrderDeliveryMetafields`, `syncOrderDeliveryScheduleTag`, `validateDeliverySelection`, `RESCHEDULED_ORDER_TAG`) are shared with the live customer reschedule route in this same repo — a greenfield namespace would import the identical services while duplicating the loader, query, table, and CSS.

**Consequence:** Phase 1+ extraction work (modals → components, KPI/filter/bulk-action hooks, dead-export deletion, docs-drift fixes D1/D2 + the development.md dev-boot note) proceeds against the existing route. No parallel second dashboard will be built or maintained.

**Exit criteria — the recommendation flips to greenfield if any of these holds (verbatim from the proposal):**

1. **If V2's UX is decided to be a queue/kanban, not a table** — then the table
   JSX (the biggest salvage item) stops being reusable and the split degrades to
   roughly 50% keep / 15% salvage / 35% rewrite, at which point greenfield wins.
2. **If Phase-1 extraction reveals the Polaris web-component modal wiring
   (`commandFor`/`command` attributes + `getElementById` show/hide) breaks when
   modals move to child components** and has no clean fix — the salvage bucket's
   "mechanical" premise fails.
3. **If the dashboard must stay bit-frozen during V2 development** (e.g. peak
   season freeze) — refactor-in-place violates the freeze by definition.

**Status:** Adopted. Phase 0 (tree cleanup + baseline) done 2026-07-08; Phase 1 not yet started.

---

## ADR-9 — Adopt Polaris React for `/app/orders` as a conscious bet against the web-components direction

**Source:** verification log 2026-07-11 (design finalization); [orders-ops-v2-ux.md](./orders-ops-v2-ux.md).

**Context:** The current `/app/orders` page is built on Polaris **web components** (`s-*`) — Shopify's stated go-forward direction for App Home surfaces. The V2 goal is interaction parity with the native Shopify Admin Orders page (saved-view tabs, `IndexFilters`, `IndexTable` with bulk bar, sortable columns). The web-components library has no equivalent of `IndexFilters`/`IndexTable`/`useIndexResourceState` today, and its command-API modal wiring is the root cause of the S1/S2/S6 defect cluster (see [orders-ops-v2-audit.md](./orders-ops-v2-audit.md)).

**Decision:** Rewrite the `/app/orders` presentation layer in Polaris **React** (`@shopify/polaris` v13). This is a deliberate bet AGAINST Shopify's web-components strategic direction, justified by component maturity: the interaction-parity goal is unachievable with the web-components set today.

**Consequence / exit cost:** A future re-migration to web components (if/when they reach feature parity) is bounded to presentation-only work because the loader/action/services/business logic stay frozen and Polaris React types must not leak into `order-utils.ts` or the services. If Shopify sunsets Polaris React for embedded apps before web components reach parity, revisit this decision.

**Status:** Accepted (design locked 2026-07-11; Phase 0 shipped, Phases 1–5 pending).

---

## ADR-10 — Merchant reschedule is an administrative override; ONE shared service defines the reschedule write sequence

**Source:** verification log 2026-07-11 (design finalization); [orders-ops-v2-ux.md §5](./orders-ops-v2-ux.md).

**Context:** Orders Ops V2 Phase 4 makes `/app/orders` the **4th delivery write path** (merchant manual reschedule). The principal-architecture review found two structural problems with the original "reuse the same services" plan: (1) the customer reschedule route (`public.customer-account.reschedule.ts`) actually **inlines** its whole write orchestration — it does NOT call `syncOrderDeliveryMetafields`/`syncOrderDeliveryScheduleTag`, and it does NOT update the legacy mirror metafields (`delivery.date`, `delivery.time_slot`, `sidekick.delivery_date`), leaving them stale after every customer reschedule; (2) `validateDeliverySelection` bundles the cutoff/prep/`maxDays` date-window policy with the data-integrity checks, so reusing the engine as-is would block the merchant path's primary use case (phoned-in too-close reschedules).

**Decision (merchant policy, stated 2026-07-11):** The merchant manual reschedule is an **administrative override** — customer self-service restrictions (`resched` lock, `≥2-days` gate, `FULFILLED` gate, cutoff/prep window) apply ONLY to the Customer Account flow and never bind the merchant. Data-integrity validations (date format, slot exists, blocked dates/slots) stay hard-enforced; slot capacity becomes **warn + explicit confirm override** (the merchant is the final authority on their own capacity). One new shared service `rescheduleOrderDelivery()` (`app/services/reschedule-order-delivery.server.ts`) defines the entire write sequence; the customer route is refactored onto it, and BOTH sources then write the legacy mirrors (fixing the stale-mirror inconsistency).

**Explicitly declined (accepted risks, recorded so they are not re-litigated):** no pre-write race-guard on the merchant op; no `reschedule_history` re-read before append (concurrent customer+merchant writes can lose one history event); no staff actor identity in history events (`source: "merchant"` is the only attribution); no fulfilled-order confirm dialog.

**Consequence:** When Phase 4 ships, api.md §2 gains a 4th write path, the `/app/orders` caveat is removed, and the Customer Account reschedule row changes (mirrors now written). Any future change to a data-integrity validation requires documented reasoning + impact analysis in the docs set **before** implementation.

**Status:** Accepted (design locked 2026-07-11; implementation pending Phase 4).

## ADR-11 — In-app customer email via the merchant's business SMTP mailbox (Gmail API rejected)

**Source:** [customer-email-design.md](./customer-email-design.md) (design locked 2026-07-12, merchant-approved); verification log 2026-07-13 (implementation + live smoke).

**Context:** The panel's "Send email" went through three shapes during Orders Ops V2 (§8-FST audit §G): `mailto:` (dead on machines with a circular OS handler chain), then a Gmail-compose-tab link (reliable, but leaves the app and assumes the merchant's Gmail). The merchant's actual expectation was the native Shopify-admin experience: compose inside the app, system sends the mail.

**Decision:** Server-side send through the merchant's **business mailbox on Namecheap Private Email via plain SMTP AUTH** (nodemailer, `mail.privateemail.com:465` SSL), exposed as the `sendEmail` op on `/app/orders` + a compose modal in the details panel. The **Gmail API was rejected**: `gmail.send` is a Google "sensitive" OAuth scope requiring app verification (privacy policy, homepage, weeks-long review), and testing-mode refresh tokens expire every 7 days — unworkable for a single-tenant custom app. Guardrails: recipient locked server-side (op takes an order id and re-reads the customer email; never client-supplied), auto-BCC to the sender mailbox (Private Email SMTP sends don't land in webmail Sent), plain text only, **zero order-state writes** (api.md §2 unchanged), config-gated env vars (clear error when unset).

**Learned in live smoke (2026-07-13):** op failure responses must be `200 + ok:false`, never 5xx — Cloudflare (the dev tunnel, and any CF-fronted deployment) replaces origin 502/504 bodies with its branded HTML error page, which breaks the fetcher JSON contract and blows up the embedded iframe. Validation errors stay 4xx (passed through untouched).

**Consequence:** New dependency `nodemailer`; new env vars `EMAIL_SMTP_HOST/PORT/USER/PASSWORD` + `EMAIL_FROM_NAME` (local `.env` dev, Secret Manager → Cloud Run prod); `/app/orders` gains a non-order-mutating outbound side effect. The send service is deliberately reusable for the planned Communications page.

**Status:** Accepted; shipped on `feature/customer-email`, live-verified 2026-07-13 (happy + wrong-password failure paths).

## ADR-12 — Booked counts move to metafield-date-scoped queries + a short in-memory cache (DB counter deferred)

**Source:** [scheduler-v2-audit.md](./scheduler-v2-audit.md) (2026-07-15) + [scheduler-v2-ux.md §5](./scheduler-v2-ux.md); merchant decision D1, 2026-07-15.

**Context:** The architecture principle was "booked-slot counts are computed live via Admin GraphQL on every call — never cached locally." In practice the implementation (`loadAutomaticBookedCounts`) scanned up to 20×250 = 5,000 orders filtered by `created_at` lookback on **every** rules read — including every storefront cart view (RACE-03/PERF-1) — while still being wrong: it missed old orders rescheduled into future dates (the lookback is order age, not delivery date), silently truncated past page 20, matched slots by case-sensitive exact string, and failed open to `booked: 0` on any Admin API error. Meanwhile the `orders/create` webhook compared against the stale persisted `booked: 0`, so capacity was never actually enforced at order creation (DEF-3).

**Decision (merchant, D1):** Counts are computed from **one Admin GraphQL orders search filtered by `metafields.custom.date:<date>` terms over the future capacity-tracked dates** (the same metafield-filter mechanism `/app/orders` already uses), matching **metafields only** through one canonical normalizer, excluding cancelled orders — and the raw matched bookings are **memoized in-process per shop for 60 seconds** (which also makes exclude-self-on-reschedule free). The principle is amended, not abandoned: booked counts are still **never persisted** and never authoritative-in-DB; they are live-derived with a short TTL. A Postgres counter with atomic increment (the full RACE-02 oversell fix) is **explicitly deferred** until oversell is observed to be a real business problem.

**Explicitly accepted:** up to 60s staleness in every capacity check; the TOCTOU oversell window remains (unchanged from today — there was never a reservation primitive); scan failure still fails open for sales continuity, but now surfaces as a real `countsMeta.status` warning in admin instead of a fabricated green pill.

**Consequence:** `docs/architecture.md`'s "never cached" wording must be updated when Phase 2 ships; `getScheduleRulesWithBookedCounts` keeps its signature (additive `countsMeta`); the `created_at`-lookback scan and the tag/attribute booking heuristics are deleted; pre-V2 orders whose metafield sync was blocked are consciously not counted (D4's always-sync closes that class going forward).

**Status:** Accepted (design locked 2026-07-15; implementation = Scheduler V2 Phase 2).
