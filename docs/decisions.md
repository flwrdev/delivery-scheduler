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

## ADR-13 — Override-map keys are slot *references* resolved canonically; the lenient read is the only place allowed to prune them

**Source:** verification log 2026-07-29 (rules-engine + write-path defect sweep); [scheduler-v2-ux.md §4.1/§4.2](./scheduler-v2-ux.md).

**Context:** `DeliveryScheduleConfig.disabledSlotsJson` / `slotCapacityJson` are date-keyed maps whose inner keys are slot *values* — strings written by several generations of the editor, so a key's spelling can drift from the configured slot (`"9am - 12pm"` vs `"9AM-12PM"`). Scheduler V2 §4.2 canonicalized the booked-count matcher and the validators' *slot* lookup, but the override-map lookups themselves stayed strict (`slotCapacity[date][slotValue]`, `disabledSlots[date].includes(...)`). A drifted cap was therefore counted and rendered "Full" on the dashboard while **never being enforced at checkout**, and a drifted block never blocked — DEF-2/DEF-4 were closed for counting only. Separately: the strict WRITE gate rejects any patch referencing a slot that is not configured, and every day-override op resubmits the whole map — so one orphan key the lenient READ kept made every later day save and every slot delete fail permanently, with no in-app way to remove the orphan.

**Decision:** (1) Every override-map lookup resolves its key through `findSlotOverrideKey` ([`app/lib/slot-value.ts`](../app/lib/slot-value.ts)) — canonical match, with an exact spelling winning a tie so a map holding both spellings resolves to the one the caller named. (2) `deserializeStoredScheduleRules` (the lenient read) is the ONE place allowed to drop override entries: it prunes keys naming no configured slot and collapses two keys on one date that canonicalize to the same slot (last wins, matching the counts engine), reporting each as a `ConfigHealthIssue`. The strict write gate keeps rejecting orphans outright.

**Consequence:** New enforcement code must go through `findSlotOverrideKey`, never `map[slotValue]` / `includes(slotValue)` — a raw lookup silently re-opens the counted-but-not-enforced split. Pruning belongs to the read: ops and routes must not delete override entries to work around a validation failure (`clearDayOverride` stays the only intentional per-date wipe, and a day-level block must not rewrite that date's per-slot config). Merchants see a drifted/orphaned key as a config-health banner on `/app/scheduler` instead of a dead editor. Stored shapes and column set are unchanged.

**Status:** Accepted; implemented 2026-07-29.

---

## ADR-14 — `shopify.app.toml` (unnamed default) is DEV; PROD moved to `shopify.app.production.toml`

**Source:** verification log 2026-07-31.

**Context:** The 2026-07-13 incident (`docs/changelog.md`, `deploy-prod` SKILL.md) had a bare `npm run deploy` release to the DEV app instead of PROD because the Shopify CLI can cache the last-used `--config` selection across sessions, independent of which toml file is the unnamed default. Before this ADR, the unnamed `shopify.app.toml` held the PROD config (client_id `a9127e5f…`) and the DEV config lived at the explicitly-named `shopify.app.delivery-scheduler-dev.toml` — meaning any command run without a `--config` flag (or with a stale cached selection) defaulted toward PROD, the more dangerous direction. Two local repos under active parallel development (`live-theme-clean`, a theme repo, and this app repo) were also fighting over a shared, unscoped browser-automation profile in Claude/Playwright/DevTools tooling, prompting a broader review of this repo's default-config hygiene.

**Decision:** Swap which file is the unnamed default. `shopify.app.toml` is now the **DEV** config (was `shopify.app.delivery-scheduler-dev.toml`; client_id `51f7d1b7…`); the former default is renamed `shopify.app.production.toml` (**PROD**; client_id `a9127e5f…`, unchanged). Per-file settings (`automatically_update_urls_on_dev`, api_version, client_id, scopes) are untouched by the rename — only the filenames swapped. `npm run deploy` (bare) is disabled (prints a reminder, exits 1); `npm run deploy:dev` / `npm run deploy:prod` and `npm run dev` (now DEV by default) / `npm run dev:prod-preview` replace every ambiguous invocation in scripts and docs.

**Consequence:** A bare `shopify app dev`/`deploy`, or a stale CLI cache, now resolves to DEV — the safe direction — instead of PROD. Every doc/script that referenced the old filenames (`CLAUDE.md`, `README.md`, `docs/development.md`, `docs/cloud-run-neon.md`, `docs/scheduler-v2-ux.md`, `e2e/README.md`, `.env.test.example`, `.claude/skills/deploy-prod/SKILL.md`) was updated in the same pass. Anyone with a local `shopify app config use delivery-scheduler-dev` cached selection should re-run `shopify app config use` (or just rely on the new default) — the named config `delivery-scheduler-dev` no longer resolves to a file on disk. Separately, `delivery-scheduler/.mcp.json` gained its own isolated `chrome-devtools`/`playwright` browser profiles (`${CLAUDE_PROJECT_DIR}/.browser/...`), matching the pattern already used in `live-theme-clean`, so the two repos' browser-automation tooling no longer shares a profile.

**Status:** Accepted; implemented 2026-07-31.

## ADR-15 — Merchant "Edit details" rewrites the shipping address only; the overwrite carry-forward lives in one function

**Source:** merchant request 2026-08-14 ("editable order details for the customer, including address and contact number"); audited before implementation in the same session.

**Context:** The details panel was read-only except for its freeform `tagsAdd` form. The merchant needed to correct a wrong address or an unreachable phone number without leaving the app for Shopify Admin. Three properties of the Admin API shaped the answer:

1. `OrderInput.shippingAddress` **merges** — despite the schema documentation saying it "Overwrites the existing shipping address". Measured live against dev-store order `#1034` on 2026-08-14: sending `address1` alone left `firstName`, `lastName`, `city`, `provinceCode`, `countryCodeV2`, and `zip` untouched. The practical consequence is the opposite of the documented one: nothing is at risk of being erased, but **a field can only be cleared by sending an explicit `""`** — omitting the key is a silent no-op that still reports success.
2. `MailingAddressInput` accepts `provinceCode` and `countryCode` only; there is no free-text `province`/`country` (the example in Shopify's own `orderUpdate` docs is stale on this). The read side spells the country `countryCodeV2`, the write side `countryCode`.
3. The customer's own phone (`customer.defaultPhoneNumber`, shown as "Sender phone") lives on the **customer record**, not the order. Changing it needs `write_customers`, which the app does not hold — and adding a scope forces a merchant reinstall.

**Decision:** Ship a single-order `editDetails` op + panel modal covering **five fields only**: `address1`, `address2`, `city`, `zip`, and the **receiver** phone (`shippingAddress.phone` — the number the rider actually calls). Recipient name, company, province, and country are **carried forward, not editable**; `buildNextShippingAddress()` in [update-order-contact.server.ts](../app/services/update-order-contact.server.ts) is the only place that carry-forward happens, and nothing else in the codebase builds a `MailingAddressInput` for an order. Given the measured merge behaviour the carry-forward is belt-and-braces rather than load-bearing, and it is kept deliberately: the *documented* contract is "overwrite", so if Shopify ever makes the behaviour match the docs, this keeps working. The stored address is **re-read server-side** at write time and never taken from the client, so the carry-forward values cannot be steered by a crafted form post. Sender phone stays read-only — declined rather than pay a reinstall for a field the rider does not dial.

**The clear-a-field rules, all measured on `#1034`:** `address2: ""` and `phone: ""` clear those fields; an omitted key does not. **`zip: ""` is rejected** ("Enter a postal code" — PH requires one) and the rejection **fails the entire mutation**, so a merchant clearing the ZIP would also lose the street and city edits submitted alongside it. The ZIP is therefore treated as un-clearable: `validateOrderContactPatch` blocks an emptied ZIP when the order has one, and the modal disables Save with an inline reason rather than letting Shopify answer with an error that discards the rest of the form.

Per the merchant's call, the op is an **administrative override in the ADR-10 sense**: it is never blocked, but the modal warns on the two cases where the edit does less than it looks like it does — a FULFILLED/in-transit order (the parcel is already out) and a changed city (shipping was priced by the courier at checkout and is not re-computed).

**Consequence:** `/app/orders` gains a **fifth order write path**, and the first one that mutates customer-facing data. It is **not** a delivery write path — it touches no delivery metafield, tag, or customAttribute, so the api.md §2 table is unchanged. The orders loader query grew five read-only fields (`firstName`, `lastName`, `company`, `provinceCode`, `countryCodeV2`) purely so the overwrite has something to carry forward. Two known limits accepted as-is: no concurrency guard (last write wins, same posture as REC-5 on the reschedule path), and the delivery fee is not re-priced on a city change (surfaced as a warning instead).

**Status:** Accepted; implemented and **live-smoked 2026-08-14** on `fix/scheduler-rules-sweep`. The smoke ran against dev-store order `#1034` (snapshot → six mutations → full restore, verified field-by-field) and **found a real bug**: the first implementation cleared a field by omitting its key, which under the actual merge semantics is a silent no-op that still reports success. Fixed by sending an explicit `""` for the clearable editable fields and blocking the un-clearable ZIP up front. 29 unit cases now pin the measured behaviour, including one asserting the exact input Shopify accepted on `#1034`.
