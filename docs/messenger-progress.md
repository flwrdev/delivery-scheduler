# FlowerCart Messenger Agent — Progress Handoff

> Pansamantalang nasa repo ito (hindi pa naka-sync ang `flowercart-messenger-build`
> Drive folder sa machine na ito); ang human ang mag-a-upload sa Drive.
> Template fields per the master doc: phase, gate result, evidence, files touched,
> deviations, open questions. **Walang secrets dito, kailanman.**

---

## Phase 4 — LLM + slot tool

**Date:** 2026-08-01
**Gate:** "correct resolved date, correct available slots"
**Gate result:** ✅ PASSED (2026-08-01, rev 00181-wlq) — apat na live test messages,
lahat ng sagot na-verify laban sa aktwal na `DeliveryScheduleConfig`:

| Test | Sagot ng bot | Verified |
|---|---|---|
| "pwede ba bukas?" (5:58 PM, lampas 5PM cutoff) | "Linggo, August 2" + 4 slots | ✓ Aug 2 2026 = Sunday; cutoff pushed min date sa bukas; slots = exact config |
| "sa Sabado sana" | "Sabado po ay August 8" + slots | ✓ next-occurrence (Aug 1 ay Sabado → Aug 8) |
| "available ba Dec 24?" | "Huwebes, Dec 24… hanggang Aug 26 lang" + nearest dates | ✓ Dec 24 2026 = Thursday; Aug 2 + maxDays 25 − 1 = Aug 26 EXACT; walang inimbentong availability |
| "magkano ang roses?" (trick) | Walang presyo; ni-refer sa ordering assistant | ✓ truthfulness rule humawak — walang tool, walang presyo |

**Provider (merchant-approved):** Claude Sonnet 5 via `@anthropic-ai/sdk`,
nakapako sa `messenger-llm.server.ts` — ang nag-iisang provider-swap file.
Secret `anthropic-api-key` sa Secret Manager (key validated 200 bago in-store;
value hindi kailanman na-print). Env: `MESSENGER_SHOP` (plain).

### Files (lahat sa commit 383966b)

`messenger-llm.server.ts` (thin interface), `messenger-agent-tools.server.ts`
(resolve_date — structured phrase input, arithmetic sa code, Asia/Manila,
weekday echo EN+Fil; get_available_slots — direktang tawag sa scheduler
engine, nearest-dates fallback), `messenger-agent.server.ts` (orchestrator:
Neon history, Manila-datetime system prompt na may verbatim truthfulness
rule, tool loop max 5, bot disclosure once, slot quick replies, repliedAt
zero-duplicate bookkeeping), quick replies sa `messenger-send.server.ts`.
Tests 327/327.

### Deviations

1. **Official Anthropic SDK** (hindi plain fetch tulad ng Messenger side) —
   ang "no SDK wrapper" ng master doc ay para sa Messenger/Graph; ang LLM
   ay nasa likod ng thin interface kaya nananatiling one-file swap.
2. **Slot quick replies auto-attached ng code** (hindi ng LLM) mula sa
   huling successful get_available_slots ng turn — "the LLM handles
   language; the code advances state."
3. **INCIDENT sa parehong araw (resolved):** habang ina-author ang phase-3
   migration, ang `prisma migrate diff --shadow-database-url <live URL>` ay
   nag-wipe ng Neon rows; narecover ang buong config via Neon time-travel
   minuto bago magsara ang 6h window. Buong detalye + standing rule sa
   `docs/known-issues.md` at verification-log.

### Open questions

1. Phase 5 next: product carousel (Generic Template, postback → variant,
   live Shopify prices). Kakailanganin ng Storefront/Admin product reads.
2. Token rotation (page token + siguraduhing hindi na kailangan i-rotate
   ang Anthropic key na hindi dumaan sa chat) — nakatakdang LAST STEP bago
   production-ready, per merchant.

---

## Phase 3 — Queue + Neon

**Date:** 2026-08-01
**Gate:** "5 rapid messages + 1 forced timeout → zero duplicate replies"
**Gate result:** ✅ PASSED (2026-08-01) — 8 messages sent live (5+ rapid, isa
may `[force-timeout]` marker), 8 na tig-iisang echo, ZERO duplicates
(screenshot + logs). Log proof (rev 00177-9xt): `force-timeout hook engaged …
stalling 45s` 06:12:40Z → Cloud Tasks retry 06:13:14Z → `skipped mid=…
(already replied)` — ang retry ay hindi nag-send ulit.

**Ingress shape ngayon:** webhook = verify → record sa Neon
(`MessengerMessage.mid` unique = Meta-redelivery dedupe) → enqueue sa Cloud
Tasks (`messenger-events`, us-central1, max 5 attempts, 30s dispatchDeadline)
→ 200. Ang worker route `POST /webhooks/messenger/worker` (ika-6 na auth
surface: HMAC `X-Messenger-Worker-Signature` keyed ng `MESSENGER_WORKER_SECRET`)
ang nag-se-send; retry-idempotent via `repliedAt`. Queue not configured
(local dev) → inline fallback; enqueue infra failure → burahin ang recorded
row para maproseso ang Meta redelivery.

### Evidence

- `npm test` — **299/299** (34 bago: 6 queue service, 13 events service,
  12 worker route, route tests reworked sa record→enqueue flow). Typecheck,
  lint, build clean. TDD: lahat ng bagong test files pinanood munang pumalya
  (missing module) bago ang implementation.
- Live gate: tingnan sa itaas. Deploys: `00176-jfj` (phase 3 code) →
  `00177-9xt` (TEMP gate hook) → **`00178-trn`** (final, hook removed),
  root probe 200.
- Worker route unsigned POST → 401 (live-probed).

### Files touched

| File | Ano |
|---|---|
| `prisma/schema.prisma` + migration `20260801000000_add_messenger_thread_message` | NEW models `MessengerThread`, `MessengerMessage` (mid unique, repliedAt/replyMid) |
| `app/services/messenger-queue.server.ts` | NEW — Cloud Tasks createTask via plain fetch (metadata-server OAuth, HMAC-signed `{ mid }` payload) |
| `app/services/messenger-events.server.ts` | NEW — `recordInboundTextMessage` (upsert + P2002 dedupe), `processEchoByMid` (repliedAt skip), `deleteRecordedMessage` |
| `app/routes/webhooks.messenger_.worker.ts` | NEW — Cloud Tasks worker (200 = done/unfixable, 503 = retry) |
| `app/routes/webhooks.messenger.ts` | echo send → record + enqueue (+ inline dev fallback) |
| `test/messenger-{queue,events}.server.test.ts`, `test/webhooks-messenger-worker.test.ts` | NEW test files |

### Infra (project lalamove-map)

Cloud Tasks API enabled; queue `messenger-events` (us-central1, max-attempts 5,
backoff 5s–120s); secret `messenger-worker-secret` (random 32-byte hex, piped
diretso sa Secret Manager — hindi na-print); IAM: `cloudtasks.enqueuer` sa
queue + `secretAccessor` sa secret para sa Cloud Run SA; Cloud Run env:
`MESSENGER_TASKS_QUEUE_PATH`, `MESSENGER_WORKER_URL`, secret
`MESSENGER_WORKER_SECRET`.

### Deviations

1. **HMAC task auth sa halip na Cloud Tasks OIDC.** Ang GCP-idiomatic na
   OIDC token verification ay mangangailangan ng `google-auth-library` +
   JWKS fetch; ang HMAC sa task payload (parehong `sha256=<hex>` format ni
   Meta, parehong tested verifier lib) ay zero bagong dependency. Ang worker
   URL ay public pero bawat task ay signed.
2. **Prod Neon repair na hindi bahagi ng plano:** nawala ang
   `_prisma_migrations` table sa prod DB (P3005 sa kahit anong bagong
   revision boot; rev 00173 nag-boot pa noong 07-31 — cause unknown, hindi
   galing sa repo). Merchant-approved fix: baseline ×3 via `prisma migrate
   resolve --applied` + `migrate deploy`. Nakatala sa
   `docs/known-issues.md` — kung umulit ang P3005, ulitin ang baseline at
   imbestigahan ang Neon restore/branch history.
3. **TEMP `[force-timeout]` gate hook** (45s stall pagkatapos ng send) —
   deployed sa 00177-9xt para sa gate, tinanggal agad sa 00178-trn.
4. **Inline fallback kapag walang queue config** — hindi nasa master doc;
   dinagdag para gumana ang local dev nang walang Cloud Tasks emulator.
   Sa prod laging naka-configure ang queue.

### Open questions

1. Phase 4 ang susunod: LLM + slot tool. **Bawal pumili ng LLM provider nang
   walang go ng merchant** (master doc) — thin interface muna, tapos
   itatanong bago pumili.

---

## Phase 2 — Echo bot

**Date:** 2026-08-01 (unang attempt 2026-07-27)
**Gate:** "your own text comes back in Messenger"
**Gate result:** ✅ PASSED (2026-08-01) — merchant nag-send ng `hello` sa
The Flowercart page, eksaktong `Echo: hello` ang balik nang isang beses.
Log evidence (rev 00169-5xn, 04:44:01Z): `[messenger] echoed mid=m_ZQLJ…
reply=m_t1VK…` — isang log line lang, patunay ng `is_echo` loop guard.

**Saga papunta sa gate (lahat may live log evidence):**

- ✅ Inbound: mula 2026-07-27 08:23Z, lahat ng events ay `messaging=1 standby=0`
  (naayos ang routing/handover saga — Business Suite Inbox routing + sticky
  thread control). Postbacks tama ang pag-skip.
- ✅ `messenger-verify-token` proven: pumasa ang Meta callback verification.
- ✅ `messenger-app-secret` proven: 0 rejected-signature sa 24h ng live POSTs.
- ❌→✅ `messenger-page-token`: namatay ang v1 (`Graph API 401: session has
  been invalidated…` — security-flux sa merchant FB account). 2026-07-27:
  bagong token → Secret Manager version 2 → Cloud Run rev 00169-5xn.
  2026-08-01: echo gate passed sa token v2.
- Post-gate cleanup: tinanggal na ang TEMP diagnostic logs sa route
  (entry-shape / standby / skipped-event) — pending redeploy ng backend.

### Evidence

- `npm test` — **208/208 passed** (35 bago: 8 signature lib, 7 send service,
  20 route — kasama ang `is_echo` loop-prevention pin, malformed-JSON-na-valid-sig
  → 200, send-failure → 200 pa rin, standby ignored, 2000-char truncation).
- `npm run typecheck` — clean. `npm run lint` — clean.
- TDD end-to-end: bawat test file isinulat muna at pinanood na pumalya
  (missing module) bago ang implementation nito.

### Files touched

| File | Ano |
|---|---|
| `app/routes/webhooks.messenger.ts` | NEW — GET verify handshake + POST events (signature verify → parse → echo → always-200) |
| `app/lib/verify-meta-signature.server.ts` | NEW — `verifyMetaWebhookSignature` (HMAC-SHA256 over raw body, timing-safe) |
| `app/services/messenger-send.server.ts` | NEW — `sendMessengerTextMessage` (plain fetch, Graph `v23.0` pinned, Bearer header only, never throws) |
| `test/verify-meta-signature.server.test.ts` | NEW — 8 cases |
| `test/messenger-send.server.test.ts` | NEW — 7 cases |
| `test/webhooks-messenger-route.test.ts` | NEW — 20 cases |
| `.gitignore` | +`*.token`, +`token.txt` |
| `.env.example` | +4 MESSENGER_* names, empty values lang |
| `docs/api.md`, `docs/architecture.md`, `docs/changelog.md`, `docs/verification-log.md` | repo docs-set updates (5th auth surface) |

### Deviations

1. **Inline send bago ang 200.** Master doc: "return 200 fast, before any
   processing." Sa RR7/Cloud Run walang `waitUntil` — kapag bumalik na ang
   response, thina-throttle ang CPU at namamatay ang fire-and-forget work
   (mismong trap na binabanggit ng master doc sa Phase 3 note). Kaya sa Phase 2:
   verify → process → `await` ng isang echo send (5s timeout) → 200. Isang Graph
   call lang ito, malayo sa Meta delivery timeout. Ang totoong fast-ack +
   enqueue ay Phase 3 (Cloud Tasks).
2. **Malformed JSON na may valid signature → 200** (hindi 400) — walang
   maaayos ang Meta redelivery sa sirang body; log lang.
3. **Echo truncation sa 2000 chars** — Messenger hard text limit; hindi nasa
   literal spec pero kailangan para hindi ma-reject ang mahabang echo.
4. **Walang dedupe sa Phase 2** — ang `mid`-unique dedupe ay Phase 3 (Neon).
   Posibleng mag-double-echo kapag nag-redeliver si Meta; tanggap sa echo bot.
5. **Progress handoff sa repo** (`docs/messenger-progress.md`) sa halip na sa
   Drive folder — hindi pa naka-sync ang `flowercart-messenger-build` sa machine
   na ito; ang human ang mag-a-upload. (Files-to-copy para sa Drive: ang tatlong
   `app/` files sa itaas + ang route test.)
6. **Page token na-proxy ni Claude (2026-07-27, explicit merchant authorization).**
   Ang master-doc rule na "human pastes secrets only" ay ni-waive ng merchant
   para ma-unblock ang gate: si Claude ang nag-generate ng token sa Meta
   dashboard, nag-store sa Secret Manager (v2), at nag-update ng Cloud Run.
   Ang token ay dumaan sa Claude session context. **Obligasyon: i-rotate ang
   `messenger-page-token` (bagong generate + bagong secret version + bagong
   revision) BAGO ideklarang production-ready.** Wala pa ring token sa repo
   o sa docs.

### Config (walang values dito — pangalan lang)

| Env var | Kind | Secret Manager name |
|---|---|---|
| `MESSENGER_APP_SECRET` | secret | `delivery-scheduler-messenger-app-secret` |
| `MESSENGER_VERIFY_TOKEN` | secret | `delivery-scheduler-messenger-verify-token` |
| `MESSENGER_PAGE_ACCESS_TOKEN` | secret | `delivery-scheduler-messenger-page-access-token` |
| `MESSENGER_PAGE_ID` | plain env (`105284684761365`) | — |

Callback URL para sa Meta dashboard:
`https://delivery-scheduler-299861709433.us-central1.run.app/webhooks/messenger`
Page fields na isu-subscribe (eksaktong 5): `messages`, `messaging_postbacks`,
`messaging_handovers`, `standby`, `message_echoes`.

### Open questions

1. Graph API version pin `v23.0` — kumpirmahin sa Meta dashboard supported
   range kapag nag-generate ng page access token; i-bump ang constant kung
   kailangan (isang linya sa `messenger-send.server.ts`).
2. Meta built-in Business AI — kumpirmahing OFF sa The Flowercart page bago
   ang live test (operator checklist sa master doc).
3. Development mode — app-role users lang (admin/developer/tester) ang
   makakatanggap ng echo; sinong account ang gagamitin sa gate test?

## Phase 5 — Product carousel (2026-08-02)

**Gate:** a tap resolves to the right variant (live re-validation, never the card price).

- `app/services/messenger-products.server.ts` — NEW: `searchShopProducts` (Admin GraphQL
  `products` query, `status:active` + optional title keyword + `price:>=/<=` bounds,
  `sortKey: BEST_SELLING`, cap 8 per the master doc) at `getVariantLive` (variant gid →
  live price/availability; tinatawag TUWING may `[TAP] PRODUCT_<variantId>` — hard rule:
  never trust a rendered card). Same `unauthenticated.admin(MESSENGER_SHOP)` pattern ng
  slots tool; designed failures, never throws, READ-ONLY (zero order writes).
- `messenger-send.server.ts` — `sendMessengerGenericTemplate` (Generic Template, hindi
  Product Template — locked decision #8): 10-element/80-char/3-button hard caps enforced;
  shared `postMessengerMessage` core.
- `webhooks.messenger.ts` — postbacks recorded na (dating ignored): synthetic mid
  `pb:<psid>:<timestamp>` (o ang postback mid kung meron), text `[TAP] <payload>`,
  same record→enqueue→worker path at dedupe ng text messages.
- Orchestrator — `search_products` tool result → carousel auto-attach pagkatapos ng text
  reply (best-effort: carousel failure after the text send ay LOG ONLY, hindi retry — no
  duplicate risk). Cards: title, live ₱price (+ "out of stock"), image, `Piliin ito`
  postback (`PRODUCT_<variantId>`) + `Tingnan sa website` URL button. Slot quick replies
  ay dinodrop kapag may carousel sa same turn (Messenger UI dismisses them anyway).
- System prompt — PRODUCT DISCOVERY section: search_products sa product/price/budget asks;
  bawal i-enumerate ang products sa text (carousel na ang magpapakita); `[TAP]` = button
  tap; laging get_product_details muna bago i-quote ang napiling product.
- Tests: 363/363 (products service, generic template caps, postback recording, carousel
  attach/failure/empty sa agent loop).
