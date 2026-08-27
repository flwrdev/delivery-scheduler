# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick orientation

Shopify embedded app (React Router 7, ported from the Shopify Remix template)
na nagdaragdag ng delivery-date / time-slot scheduling sa checkout at nag-si-sync
ng state na iyon papunta sa Shopify orders.

- **Delivery state lives on the Shopify ORDER, not in Postgres.** Postgres holds
  four Prisma models (`Session`, `DeliveryScheduleConfig`, plus the Messenger
  agent's `MessengerThread`/`MessengerMessage` conversation pair — conversation
  only, never the order); a specific order's date/slot/reschedule status lives
  as order metafields, tags, and customAttributes.
- **Booked-slot counts are computed live** via Admin GraphQL on every call — never
  cached locally, walang audit table (the `delivery.reschedule_history` metafield is
  the only persistent reschedule audit trail). Since ADR-22 Phase C the live scan
  additionally overlays still-pending `DeliverySyncTask` rows (fresh per call,
  fail-open, deduped) so a paid order counts against its slot before its sync lands.
- **Async ops work queues (ADR-22, live 2026-08-27).** The orders/create webhook is
  a THIN receiver: it records a durable `DeliverySyncTask` row and a Cloud Tasks
  worker performs the sync with per-step retries (hourly sweep backstop, ops-page
  banner for failures); bulk ops over 10 orders run as chunked `BulkActionJob`s
  through ONE shared executor (`app/services/bulk-actions.server.ts`) that the
  inline path uses too. Design + merchant constraints (no double-processing; a
  paid order is never rejected for cutoff at retry time):
  `docs/proposals/orders-async-jobs.md` + decisions.md ADR-22; the `/app/orders`
  page architecture: `docs/orders-ui.md`. **UPDATE THOSE DOCS whenever this
  machinery changes** — that is their maintenance contract.
- **Only a few surfaces write delivery state.** Most extensions and admin order-page
  blocks are read-only. Never assume a surface writes — verify in `docs/api.md`.
- **Courier dispatch is out of scope** — handled by the official Shopify Lalamove app.
  A separate, narrow Lalamove **status-listener** (ADR-16) auto-marks a fulfillment
  "Delivered" once the merchant pastes the courier's real Order ID — read-only against
  Lalamove, not dispatch; see ADR-16 before assuming all Lalamove code is banned.
- **The app sends customer emails itself** via the merchant's Private Email SMTP
  mailbox (`app/services/send-customer-email.server.ts`, in-app compose modal on
  `/app/orders`) — zero order writes. Route-op upstream failures must return
  `200 + ok:false`, never 5xx — Cloudflare replaces origin 502/504 bodies with
  its HTML error page and breaks the embedded fetcher (see ADR-11).

The full topology + data model is in `docs/architecture.md`; the route/auth/write-path
contract is in `docs/api.md`. Those docs are the source of truth — this section is only
a first-glance mental model.



## Commands

```bash
npm run dev        # shopify app dev against the DEV app (default, safe); does NOT auto-apply migrations
npm run dev:prod-preview # shopify app dev against the PROD app config (read-only preview; automatically_update_urls_on_dev=false there)

# Production deploys (merchant go required — stop-and-ask gate):
gcloud run deploy delivery-scheduler --source . --region us-central1   # backend (project lalamove-map)
npm run deploy:prod                                                     # app config + extensions to the PROD app
# ⚠️ NEVER use the bare `shopify app deploy` / `npm run deploy` — always npm run deploy:dev
# or npm run deploy:prod explicitly. (shopify.app.toml = DEV, shopify.app.production.toml = PROD,
# swapped 2026-07-31 after a bare deploy hit the DEV app on 2026-07-13; see ADR-14.)
```

Only `test/**/*.test.{ts,tsx}` are picked up by vitest; `e2e/` specs are excluded and
run separately. API version is pinned per config: `2026-04` in `shopify.app.production.toml`
(prod), `2026-04` in `shopify.app.toml` (dev — see `docs/development.md` for any drift
between the file and what's live on Partners). Full dev / testing / deployment (Cloud Run +
Neon cold-start) notes are in `docs/development.md`.

## Read before editing (source of truth)

Read in this order before touching `app/`, `extensions/`, `prisma/`,
or `shopify.app.toml` / `shopify.app.production.toml`:

1. `docs/architecture.md` — system topology + data model (source of truth)
2. `docs/api.md` — routes, auth mechanisms, order write-path contract
3. `docs/known-issues.md` — don't collide with in-flight fixes
4. `docs/development.md` — commands, dev/testing/deployment notes

Rules:

- Never assume a write path — verify it in `docs/api.md` first.
- After any architectural change: update the relevant doc(s) +
  `docs/verification-log.md`, and add an entry to `docs/changelog.md`
  and/or `docs/decisions.md` if applicable.
- Courier dispatch is out of scope — handled by the official Shopify
  Lalamove app. Do not reintroduce custom Lalamove **dispatch** code
  (booking, editing, or cancelling a delivery — see `docs/decisions.md`
  ADR-1). This does NOT ban all Lalamove code: a narrow, read-only
  courier-**status-listener** exists (ADR-16) to auto-mark a fulfillment
  "Delivered" — it never dispatches. Read ADR-16 before touching anything
  Lalamove-shaped so you don't rip out a live feature by mistake.
- After creating or pulling any new Prisma migration, explicitly tell
  the user: "Run `npm run setup` before your next `npm run dev`" —
  dev boot no longer auto-applies migrations (see shopify.web.toml
  commit 00482e1).
- **Leaving this repo requires the merchant's explicit go — every time.** Working
  outside the repo root (`cd`, absolute paths, searches, or cloning/pulling another
  repo such as the live theme) is ALLOWED, but only after a **stop-and-ask** via
  `AskUserQuestion` that names the exact path and what will be read or written.
  Wait for the answer; do not proceed on assumption. **This gate holds even when
  auto-accept / bypass permissions is on** — auto mode approves tool calls, it does
  NOT approve crossing the repo boundary. Approval is per-task, not standing: a yes
  for one excursion does not carry to the next. The scratchpad directory is the only
  standing exception.

## Delivery coverage & fees — SI JHAY ANG MAY-ARI; isa lang ang computation

**Ang merchant ang final na awtoridad sa fees at coverage. Ang section na ito
ay gabay para sa AI sessions LANG — kailanman hindi ito hadlang o kandado sa
merchant.** Kapag may gusto siyang baguhin, kahit gaano kaliit: ipakita agad
ang kasalukuyang values, gawin ang pagbabago niya, at i-propagate sa mga
consumer sa ibaba — huwag pigilan, huwag pagtalunan, huwag pagpaliwanagin.
Ang fee drift ay maliit at madaling ayusin (walang data exposure, walang
privacy issue) — kung magkaroon man nito dahil sa pagbabago niya, desisyon
niya iyon at ayos lang. Ang TANGING bawal dito ay ang AI na mag-imbento o
mag-hand-edit ng fee numbers na walang basehan sa engine niya — iyon ang
pinagmulan ng "imbento" complaints, at iyon lang ang pinoprotektahan ng
section na ito.

Para sa konsistensiya, one computation feeds everything:

- **Source:** `app/data/ncr-zipcodes.ts` (merchant's zip/barangay list, 375
  entries, 17 NCR cities) + the km-based fee estimate in
  `app/services/messenger-coverage.server.ts` — haversine × 1.4 road factor
  from the Tondo pickup point; ₱49 base + ₱6/km first 5 km + ₱5/km beyond
  + ₱40 handling. This mirrors the distance-based checkout rate. The old
  per-city flat table (₱150–₱300) in the same file is a legacy FALLBACK only
  — never quote it as primary.
- **Consumers (all must stay in lockstep):** FlowerBot's
  `check_delivery_coverage` tool; the storefront delivery-checker on the
  Delivery Coverage page (App Proxy `/apps/schedule-rules/coverage` — reuse
  this endpoint, never re-implement the formula); checkout; and the Shopify
  Knowledge Base `shopify--qa-pair` metaobjects with `fc-coverage-*` handles
  (18 coverage entries, per-city km-range answers, written 2026-08-25 via
  Admin GraphQL `metaobjectUpsert`).
- **The Knowledge Base is the merchant-controlled hard copy** and the
  knowledge source AI surfaces read (Inbox agent, external shopping agents
  via MCP/agentic storefronts, FlowerBot's FAQ grounding). It is a SNAPSHOT:
  kapag binago ng merchant ang fees, coverage areas, o ang formula, ang
  trabaho ng session ay i-regenerate ang `fc-coverage-*` entries mula sa
  parehong source pagkatapos ng pagbabago niya. AI sessions must never
  hand-edit fee numbers into the KB, prompts, or theme pages that differ
  from the engine — ang merchant ang nagbabago ng presyo, ang AI ang
  nagpapalaganap nito nang tapat.
- ⚠️ **Known gap:** `app/services/faq-facts.server.ts` fetches only the
  first 50 qa-pairs but the KB now holds 62 — the agent's FAQ grounding set
  is currently an arbitrary 50. Pending fix: fetch handles, exclude
  `fc-coverage-*` (FlowerBot has the live tool; tool wins over FAQ anyway),
  raise the cap with the pagination guard kept.
- Full compiled agent knowledge (coverage tables, fees, slots, policies,
  40 original FAQs): `docs/flowerbot-training-data.md`.
