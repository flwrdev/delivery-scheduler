# FlowerCart Messenger Agent: Progress Handoff

> Pansamantalang nasa repo ito (hindi pa naka-sync ang `flowercart-messenger-build`
> Drive folder sa machine na ito); ang human ang mag-a-upload sa Drive.
> Trimmed sa: phase, files touched, at kung ano ang binago sa code. Ang mga
> desisyon/rationale ay nasa [decisions.md](./decisions.md). **Walang secrets dito, kailanman.**

---

## Phase 4: LLM + slot tool

**Date:** 2026-08-01

**Provider:** Claude Sonnet 5 via `@anthropic-ai/sdk`, nakapako sa
`messenger-llm.server.ts` (ang nag-iisang provider-swap file). Secret
`anthropic-api-key` sa Secret Manager (key validated 200 bago in-store;
value hindi kailanman na-print). Env: `MESSENGER_SHOP` (plain). Provider
choice + rationale: [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md).

### Files (lahat sa commit 383966b)

`messenger-llm.server.ts` (thin interface), `messenger-agent-tools.server.ts`
(resolve_date: structured phrase input, arithmetic sa code, Asia/Manila,
weekday echo EN+Fil; get_available_slots: direktang tawag sa scheduler
engine, nearest-dates fallback), `messenger-agent.server.ts` (orchestrator:
Neon history, Manila-datetime system prompt na may verbatim truthfulness
rule, tool loop max 5, bot disclosure once, slot quick replies, repliedAt
zero-duplicate bookkeeping), quick replies sa `messenger-send.server.ts`.
Tests 327/327.

### Deviations

Design-choice deviations moved to [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md) (Phase 4 entries). Ang shadow-database migration incident ng phase na ito ay nasa `docs/known-issues.md` at verification-log.

---

## Phase 3: Queue + Neon

**Date:** 2026-08-01

**Ingress shape ngayon:** webhook = verify → record sa Neon
(`MessengerMessage.mid` unique = Meta-redelivery dedupe) → enqueue sa Cloud
Tasks (`messenger-events`, us-central1, max 5 attempts, 30s dispatchDeadline)
→ 200. Ang worker route `POST /webhooks/messenger/worker` (ika-6 na auth
surface: HMAC `X-Messenger-Worker-Signature` keyed ng `MESSENGER_WORKER_SECRET`)
ang nag-se-send; retry-idempotent via `repliedAt`. Queue not configured
(local dev) → inline fallback; enqueue infra failure → burahin ang recorded
row para maproseso ang Meta redelivery.

### Files touched

| File | Ano |
|---|---|
| `prisma/schema.prisma` + migration `20260801000000_add_messenger_thread_message` | NEW models `MessengerThread`, `MessengerMessage` (mid unique, repliedAt/replyMid) |
| `app/services/messenger-queue.server.ts` | NEW: Cloud Tasks createTask via plain fetch (metadata-server OAuth, HMAC-signed `{ mid }` payload) |
| `app/services/messenger-events.server.ts` | NEW: `recordInboundTextMessage` (upsert + P2002 dedupe), `processEchoByMid` (repliedAt skip), `deleteRecordedMessage` |
| `app/routes/webhooks.messenger_.worker.ts` | NEW: Cloud Tasks worker (200 = done/unfixable, 503 = retry) |
| `app/routes/webhooks.messenger.ts` | echo send → record + enqueue (+ inline dev fallback) |
| `test/messenger-{queue,events}.server.test.ts`, `test/webhooks-messenger-worker.test.ts` | NEW test files |

### Infra (project lalamove-map)

Cloud Tasks API enabled; queue `messenger-events` (us-central1, max-attempts 5,
backoff 5s–120s); secret `messenger-worker-secret` (random 32-byte hex, piped
diretso sa Secret Manager: hindi na-print); IAM: `cloudtasks.enqueuer` sa
queue + `secretAccessor` sa secret para sa Cloud Run SA; Cloud Run env:
`MESSENGER_TASKS_QUEUE_PATH`, `MESSENGER_WORKER_URL`, secret
`MESSENGER_WORKER_SECRET`.

### Deviations

Moved to [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md) (Phase 3 entries). The prod Neon `_prisma_migrations` repair itself is also tracked in `docs/known-issues.md`: if P3005 recurs, redo the baseline and check Neon restore/branch history.

---

## Phase 2: Echo bot

**Date:** 2026-08-01 (unang attempt 2026-07-27)

### Files touched

| File | Ano |
|---|---|
| `app/routes/webhooks.messenger.ts` | NEW: GET verify handshake + POST events (signature verify → parse → echo → always-200) |
| `app/lib/verify-meta-signature.server.ts` | NEW: `verifyMetaWebhookSignature` (HMAC-SHA256 over raw body, timing-safe) |
| `app/services/messenger-send.server.ts` | NEW: `sendMessengerTextMessage` (plain fetch, Graph `v23.0` pinned, Bearer header only, never throws) |
| `test/verify-meta-signature.server.test.ts` | NEW: 8 cases |
| `test/messenger-send.server.test.ts` | NEW: 7 cases |
| `test/webhooks-messenger-route.test.ts` | NEW: 20 cases |
| `.gitignore` | +`*.token`, +`token.txt` |
| `.env.example` | +4 MESSENGER_* names, empty values lang |
| `docs/api.md`, `docs/architecture.md`, `docs/changelog.md`, `docs/verification-log.md` | repo docs-set updates (5th auth surface) |

### Deviations

Moved to [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md) (Phase 2 entries, including the page-token proxy-by-Claude incident: closed 2026-08-03).

### Config (walang values dito: pangalan lang)

| Env var | Kind | Secret Manager name |
|---|---|---|
| `MESSENGER_APP_SECRET` | secret | `delivery-scheduler-messenger-app-secret` |
| `MESSENGER_VERIFY_TOKEN` | secret | `delivery-scheduler-messenger-verify-token` |
| `MESSENGER_PAGE_ACCESS_TOKEN` | secret | `delivery-scheduler-messenger-page-access-token` |
| `MESSENGER_PAGE_ID` | plain env (`105284684761365`) |: |

Callback URL para sa Meta dashboard:
`https://delivery-scheduler-299861709433.us-central1.run.app/webhooks/messenger`
Page fields na isu-subscribe (eksaktong 5): `messages`, `messaging_postbacks`,
`messaging_handovers`, `standby`, `message_echoes`.

## Phase 5: Product carousel (2026-08-02)

- `app/services/messenger-products.server.ts`: NEW: `searchShopProducts` (Admin GraphQL
  `products` query, `status:active` + optional title keyword + `price:>=/<=` bounds,
  `sortKey: BEST_SELLING`, cap 8 per the master doc) at `getVariantLive` (variant gid →
  live price/availability; tinatawag TUWING may `[TAP] PRODUCT_<variantId>`: hard rule:
  never trust a rendered card). Same `unauthenticated.admin(MESSENGER_SHOP)` pattern ng
  slots tool; designed failures, never throws, READ-ONLY (zero order writes).
- `messenger-send.server.ts`: `sendMessengerGenericTemplate` (Generic Template, hindi
  Product Template: locked decision #8): 10-element/80-char/3-button hard caps enforced;
  shared `postMessengerMessage` core.
- `webhooks.messenger.ts`: postbacks recorded na (dating ignored): synthetic mid
  `pb:<psid>:<timestamp>` (o ang postback mid kung meron), text `[TAP] <payload>`,
  same record→enqueue→worker path at dedupe ng text messages.
- Orchestrator: `search_products` tool result → carousel auto-attach pagkatapos ng text
  reply (best-effort: carousel failure after the text send ay LOG ONLY, hindi retry: no
  duplicate risk). Cards: title, live ₱price (+ "out of stock"), image, `Piliin ito`
  postback (`PRODUCT_<variantId>`) + `Tingnan sa website` URL button. Slot quick replies
  ay dinodrop kapag may carousel sa same turn (Messenger UI dismisses them anyway).
- System prompt: PRODUCT DISCOVERY section: search_products sa product/price/budget asks;
  bawal i-enumerate ang products sa text (carousel na ang magpapakita); `[TAP]` = button
  tap; laging get_product_details muna bago i-quote ang napiling product.
- Tests: 363/363 (products service, generic template caps, postback recording, carousel
  attach/failure/empty sa agent loop).

## Phase 6: Draft order + invoice (2026-08-02, PENDING scope approval)

- `app/services/messenger-orders.server.ts`: NEW: slot-filling state machine (code
  advances state, LLM language lang; fields sa fixed order product→date→slot→recipient→
  address→phone; jump-back clears only that field) + idempotent draftOrderCreate.
- Idempotency: conversationOrderKey (UUID) sa Neon BAGO ang anumang Shopify call; dala ng
  draft bilang custom attribute + tag `mo-key-<uuid>`; check-before-create; ambiguous/
  timeout → lookup-by-tag adopt, never blind retry; stale-key guard; created-replay =
  zero Shopify calls.
- Frozen shapes: draft carries "Delivery Date"/"Delivery Time" customAttributes + [date,
  slot] tags (exact checkout shape) + `messenger` tag; existing orders/create sync ang
  bahala sa metafields pag nabayaran ang invoice. reserveInventoryUntil 15 min.
- Deterministic CONFIRM: [TAP] CONFIRM_ORDER_<key> ay code path, hindi LLM; code-composed
  ang summary (Confirm ✅ / Baguhin quick replies) at ang confirm reply.
- Webhook: quick_reply.payload recorded na bilang "[TAP] <payload>" (dating title lang).
- **ENV GATE**: MESSENGER_ORDERS_ENABLED=true ang kailangan bago mag-alok ng ordering ang
  bot: naka-OFF by default dahil kailangan pa ng read/write_draft_orders scopes
  (config deploy + merchant re-approval sa store) bago gumana ang draftOrderCreate.
- Gate-review adds (main agent): sanitizeMessengerText (markdown strip sa lahat ng sends),
  search_products purpose=lookup (walang carousel sa pagpili ng pangalan), Cloud Tasks
  dispatchDeadline 30s→180s.
- Tests: 418/418. New migration 20260802000000 (orderStateJson + conversationOrderKey sa
  MessengerThread): auto-applied sa prod via docker-start; sa local: npm run setup.

## Phase 7: Human takeover + disclosure (2026-08-02)

- Webhook echo branch (dating blanket skip): echo na HINDI galing sa bot = operator
  typing sa Business Suite -> humanControl=true + humanControlAt=now + operator row
  recorded (role "operator"; psid mula sa recipient.id: baliktad ang roles sa echoes).
  Walang task na ine-enqueue para sa echo, kailanman.
- Discriminator: message.app_id PRIMARY (present = app-sent = sarili nating bot, panalo
  din sa bookkeeping race), bot-mid Neon lookup ang FALLBACK.
- Mute: processAgentTurnByMid -> skipped bago pa ang LLM at bago ang CONFIRM path
  (kasama ang Confirm taps sa mute: deviation, deliberate). Bot KEEPS LISTENING:
  recorded pa rin lahat. repliedAt untouched (zero-duplicate contract).
- Auto-handback: 6h default (MESSENGER_HANDBACK_HOURS env) na walang operator message
  (bawat operator echo nagre-refresh ng humanControlAt) -> clear flag + disclosedBot=false
  = sapilitang re-disclosure (Meta policy). humanControl na walang timestamp = muted
  indefinitely (manual Resume ang recovery).
- NEW app/routes/app.messenger-orders.tsx (embedded, authenticate.admin, ADR-11 ok:false):
  thread list + per-thread Pause/Resume. Resume = humanControl off + re-disclosure.
  Neon-only; ang Shopify orders listing ay Phase 8. NavMenu "Messenger" link sa app.jsx.
- History: operator rows -> assistant turns na may "[HUMAN AGENT] " prefix + system-prompt
  rule na huwag kontrahin ang sinabi ng tao.
- Tests 450/450; typecheck + lint clean. Walang migration (humanControl/humanControlAt
  ay nasa schema na since phase 3).

## Phase 8: Orders listing + typing indicator + Messenger profile (2026-08-03)

- `/app/messenger-orders`: bagong Shopify orders section (READ-ONLY): Admin GraphQL
  `orders(query: "tag:messenger", first: 25, CREATED_AT desc)` sa existing
  `authenticate.admin` loader; columns: order name (`shopify://admin/orders/<id>` deep
  link, same idiom ng OrderDetailsPanel), created, customer/recipient display name,
  Delivery Date/Time (mula sa customAttributes), payment status, total. Upstream Graph
  failure → error Banner lang, buo pa rin ang threads section (walang crash). ZERO order
  writes: hindi nagbago ang §2 write-paths table ng api.md.
- `messenger-send.server.ts`: `sendMessengerSenderAction` (typing_on / typing_off /
  mark_seen): sariling body-builder (`{ recipient, sender_action }`, WALANG `message`
  field) sa ibabaw ng shared `postMessengerSendApi` core (parehong token/URL/timeout/
  error handling); never throws. Orchestrator: `typing_on` fire-and-forget bago ang LLM
  turn: pagkatapos ng humanControl mute gate (walang typing sa muted thread) at
  pagkatapos ng deterministic confirm-tap check; walang typing_off (kusa itong
  naki-clear pagdating ng reply).
- NEW `app/services/messenger-profile.server.ts`: `setMessengerProfile()` (isang POST
  sa `/me/messenger_profile`: Get Started `GET_STARTED`, 4 Taglish ice breakers
  `ICEBREAKER_PRODUCTS/FEE/SAMEDAY/ORDER`, persistent menu: 2 web_url + postback
  `MENU_ORDER`) at `getMessengerProfile()` (fields read para sa set/not-set display).
  Same conventions ng messenger-send: pinned Graph version, token sa Authorization
  header lang, designed failures. Merchant-triggered button "I-setup ang Messenger
  profile" sa page (route op `setupProfile`, ADR-11: 200 + ok:false + error toast);
  profile status sa loader ay best-effort ("unknown" sa failure).
- Postbacks ng profile buttons ay dumadaan sa EXISTING webhook postback path bilang
  `[TAP] <payload>`: zero webhook changes. System prompt: bagong maikling
  "MENU & GREETING TAPS" section (append-only; walang binago sa existing sections),
  kasama ang env-gated na sagot sa ICEBREAKER_ORDER/MENU_ORDER (ordering flow kapag
  MESSENGER_ORDERS_ENABLED, else website).
- Tests: 478/478 (28 bago: 4 sender action, 13 profile service, 7 route
  orders/profile, 6 agent typing + prompt taps). Typecheck + lint clean. Walang migration,
  walang bagong env var, walang bagong dependency.

### Deviations (phase 8)

Moved to [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md) (Phase 8 entries).

## Phase 9: Product descriptions + typo-tolerant search (2026-08-03)

- **Descriptions reach the LLM**: `messenger-products.server.ts`: `descriptionHtml`
  idinagdag sa search query at sa `getVariantLive` product lookup; bagong pure helper
  `productDescriptionText()` (strip tags, `<li>` → `-` bullets, unescape entities,
  collapse whitespace, cap 1200 chars keep-the-start: nasa unahan ang BLOOMS/SIZE/
  COMES WITH bullets; 65/89 products may BLOOMS section). Ang `description` ay optional
  field na ng `MessengerProduct`, kaya dumadaloy ito sa tool results ng PAREHONG
  `search_products` at `get_product_details` (ang orchestrator ay `JSON.stringify` ng
  buong result): pero HINDI sa carousel cards (title/price/image lang doon). Bounded:
  8 results × 1200 chars max.
- **Typo-tolerant fallback**: `searchShopProducts`: kapag ZERO ang keyword search
  (at may keyword), isang titles-only query (`first: 100`, `status:active`) ang
  kinukuha at fuzzy-match IN CODE via bagong exported `fuzzyTitleSimilarity()`
  (bigram/Sørensen–Dice, walang bagong dependency; normalize = lowercase + strip
  punctuation). Threshold ≥ 0.55, best-first, cap 3 guesses, tapos isang full refetch
  na may `title:"..."` OR terms (kasama pa rin ang price bounds ng customer). Result
  shape unchanged + optional `fuzzyMatched: true` flag.
- **Prompt (append-only, 2 bullets sa PRODUCT DISCOVERY):** INCLUSIONS: sagutin mula
  sa description sa tool result; kung walang BLOOMS info, aminin at i-offer ang product
  page link, NEVER invent inclusions. `fuzzyMatched=true` → i-confirm muna ang product
  name bago i-quote nang final. Walang binago sa existing prompt sections.
- READ-ONLY pa rin ang product queries (zero writes); walang bagong env var, walang
  migration, walang dependency. Tests 478 → 498 (20 bago: 4 description helper,
  4 fuzzy helper, 2 description-sa-result, 6 fallback query shapes/gating, 4 agent
  prompt + tool-result flow). Typecheck + lint + build clean.

## Phase 10: Add-on upsell + abandoned-order follow-up (2026-08-03)

- **Add-on upsell** (`messenger-orders.server.ts`): bagong `add_on` required step
  pagkatapos ng phone: one-time offer (addOnDecided gate). Pumili = validated
  live via parehong getVariant (out-of-stock rejected); tumanggi = add_on:"none".
  Quick replies auto-attached ng code (🧸 Bear / 🍫 Chocolates / 🎈 Balloon /
  Hindi na po → ADDON_* payloads; prompt rules ang nagmamapa sa search_products
  per category). Summary may "Add-on:" line; draft order may PANGALAWANG line
  item. Grandfather clause: mga in-flight na awaiting_confirm/created state bago
  ang deploy ay itinuturing nang desidido (hindi masisira ang lumang Confirm taps).
- **Abandoned follow-up**: pag-send ng summary → delayed Cloud Tasks task
  (`scheduleTime`, walang bagong infra; `MESSENGER_FOLLOWUP_HOURS` default 3,
  0 = off). Worker route dispatch sa `processOrderFollowUp`: guards: humanControl
  off; huling customer message > 45 min (hindi sasabad sa aktibong usapan) at
  < 20h (Meta 24h window na may margin); `claimOrderFollowUp` = **mark-BEFORE-send**
  (followUpSentAt sa Neon bago ang Graph call) kaya zero-duplicate kahit mag-retry
  ang Cloud Tasks; send failure pagkatapos ng claim = give up, hindi inuulit.
  Deterministic ang reminder text + Confirm ✅ / Baguhin quick replies (ang tap ay
  dumadaan sa existing deterministic confirm path).
- Tests: 531/531 (+32: 13 orders add-on/claim, 13 agent, 2 queue scheduleTime,
  4 worker dispatch). Typecheck/lint/build clean. Walang migration (state fields
  nasa orderStateJson), walang bagong scope, walang bagong dependency.

### Deviations (phase 10)

Moved to [decisions.md § Messenger Agent Phase Deviations Log](./decisions.md) (Phase 10 entries).

## Phase 11: Streamlined checkout flow + email order lookup + lost-message fix (2026-08-03)

- **Streamline:** tinanggal sa REQUIRED_FIELDS ang recipient_name/address/phone. Ang
  Shopify checkout na ang kokolekta ng shipping. Kusang-bigay na details ay sine-save
  pa rin (checkout prefill + coverage check). Summary: shipping lines lumalabas lang
  kapag ibinigay; may "doon niyo na ilalagay ang delivery address" na note. Draft order:
  shippingAddress isinasama lang kapag may address.
- **lookup_order tool (bagong tool #7):** order status by checkout EMAIL;
  gumagana pati sa WEBSITE orders. Limitadong fields lang ang ibinabalik/ibinubunyag:
  order number, payment/fulfillment status, delivery date/time: KAILANMAN walang
  address/phone/payment details; zero matches = hindi kinukumpirma kung existing ang
  email. READ-ONLY query.
- **Lost-message fix:** sa 00203 deploy overlap, nag-timeout ang Neon connection
  pool → record failed → 200 pa rin ang sagot kay Meta → tuluyang nawala ang 2 messages
  (walang redelivery sa 200). Ngayon: record failure → **503** → nagre-redeliver si
  Meta; ligtas dahil mid-unique dedupe.
- Tests: 538/538 (+7 lookup/streamline; 3 in-place updates). Typecheck/lint/
  build clean. Walang migration, walang bagong scope/env/dependency.
- Post-deploy: `MESSENGER_FOLLOWUP_HOURS` reverted to `3` (rev `00206-5qm`) pagkatapos
  ng isang test window kung saan pinababa ito.

## Phase 12: image recognition: screenshot ng ad → product match (2026-08-04)

- **Webhook:** ang mga message na may `attachments[type=image]` ay hindi na
  nilalaktawan: nire-record ang caption + `[IMAGE] <cdn-url>` lines (cap 3,
  walang migration). Non-image attachments (audio/stickers) ay skip pa rin.
- **Agent:** ang CURRENT message lang ang fina-fetch ang images (8s timeout,
  4MB cap, jpeg/png/gif/webp lang) at ipinapasa bilang base64 vision blocks
  sa LLM; ang mga LUMANG image rows ay nagiging placeholder na lang (expired
  na ang Meta CDN urls, sayang ang re-fetch). Fetch failure → "hindi ma-load"
  na note, hindi kailanman crash.
- **LLM interface:** +`image` content block sa `LlmContentBlock` (base64
  source): dumadaan nang direkta sa Anthropic API (vision-capable na ang
  claude-sonnet-5, walang bagong dependency).
- **Prompt:** bagong "PHOTOS" section: ilarawan ang bouquet mula sa larawan,
  i-search via search_products (flower type + color keywords), CONFIRM FIRST
  ang 1-3 matches na may presyo mula sa tool result bago mag-quote; huwag
  kailanman kunin ang presyo mula sa photo mismo.
- Tests: 546/546 (+7: 3 webhook, 4 agent incl. no-fetch-for-old-rows pin).
  Typecheck clean.

## Phase 13: product discovery filters, best sellers, prompt caching (2026-08-04)

**Status:** naisulat 2026-08-04, naidokumento 2026-08-13, **HINDI PA NA-DEPLOY**.
Walang Cloud Run revision.

### Ano ang binago

- **`search_products`: apat na bagong param.**
  - `sort=price_asc|price_desc` para sa "pinakamura/pinakamahal". Walang
    product-level price sortKey ang Shopify (variant-level ang presyo), kaya
    bounded pool (`SORT_POOL_LIMIT = 100`) ang kinukuha at **in code** nag-so-sort,
    tapos `PRODUCT_CAROUSEL_LIMIT` lang ang ibinabalik. Ang prompt rule:
    pwede LANG magsabi ng superlative kapag galing sa sorted result: bawal
    tantiyahin mula sa unsorted browse.
  - `tags` / `exclude_tags`: reliable na color/type/compound matching
    (pink, red, white…, roses, carnation, lilies…, "red rose", "white rose").
    "puro white" → `tags=["white"]`; "ayaw ko ng roses" → `exclude_tags=["roses"]`.
    Kapalit ito ng title-guessing.
  - `addons`: scope switch. Ang normal na bouquet browse/sort/reco ay laging
    nagpupush ng `-tag:'Add-ons'`; ang add-on upsell ay opt-in na `tag:'Add-ons'`.
- **`get_best_sellers`: bagong tool.** Fixed na 7 merchant-curated titles
  (Autumn Morning, Sweet Heart, California Dreaming, Luxe Noir, Majestic Bouquet,
  Meadow Fresh, Crimson Whisper) via OR-of-titles query, ibinabalik sa curated
  order (ang matched-but-unlisted ay idinudugtong defensively). **Hindi** ito
  Shopify best-selling metric at hindi collection link. Ang result ay
  sumasakay sa parehong carousel path ng `search_products`, at ipinagbabawal ng
  prompt na tawaging best seller ang plain search result.
- **Hidden products skip.** Nilalaktawan na ng `runProductSearch` ang node na
  walang `onlineStoreUrl`: para hindi sumulpot ang internal na "COD Fee"
  product sa carousel ng customer.
- **Prompt caching.** Hinati ang prompt: `buildStaticSystemPrompt(ordersEnabled)`
  (byte-identical sa bawat conversation: deploy-constant ang `ordersEnabled`)
  at `buildDynamicContext(now)` (ang petsa lang). Isang `cache_control:
  {type:"ephemeral"}` breakpoint sa static block; dahil ang render order ay
  **tools → system → messages**, sakop nito ang buong tools+system prefix, at
  ang volatile na petsa ay nasa trailing **uncached** block. Ang
  `buildSystemPrompt()` ay pinanatili bilang concatenation ng dalawa.
  Bagong log line: `[messenger-llm] input=… cache_write=… cache_read=… output=…`,
  **counts lang, kailanman walang message text**.
- **Prompt corrections.**
  - "SF" = shipping fee, **hindi** San Francisco. Magtanong muna ng
    barangay/city/zip bago mag-quote; bawal ipasa ang "SF" sa `check_delivery_coverage`.
  - Delivery hours = hanggang **11PM** (may 6PM–11PM slot). Ang 5PM ay closing
    ng **walk-in store**, hindi delivery limit. Bawal sabihing 5PM na ang huli.
  - 5PM same-day cutoff: pwede nang sabihin nang direkta kapag tinanong.
  - 7 araw kada linggo, **walang holiday closure**.
  - Ang pagpapabago/cancel ng **nailagay nang order** ay purong self-service sa
    flowercart.store/account. Bawat mangako ang bot na siya ang gagawa;
    iba ito sa order na binubuo pa sa chat (`update_order` bago mag-Confirm).
  - COD **lampas ₱2,500** = online payment lang; tinanggal ang split-payment
    arrangement.
  - `resolve_date` ay required **kahit** "today"/"ngayon"/"bukas".
  - Add-on taps → `search_products` na may `addons=true` + keyword.
- **Coverage alias fix.** Kapag miss ang exact `AREA_ALIASES` lookup, may
  whole-word regex pass na nag-e-expand ng naka-embed na alias:
  "BGC, Taguig" → fort bonifacio (dati ay exact-match lang).
- Tests 546 → 547 (+1: trailing uncached `systemContext` block); typecheck at
  lint clean.

Walang migration, walang bagong env/secret/dependency, walang binago sa write path.

### ⚠️ Hindi pa na-verify sa totoong store

1. **`onlineStoreUrl` skip = silent behavior change.** Dati, ang product na
   walang storefront URL ay ibinabalik pa rin (`url` lang ang wala). Kung ang
   add-ons (bear/chocolates/balloon) ay **hindi published sa Online Store
   channel**, magiging **zero** ang `search_products addons=true` at masisira
   ang Phase 10 add-on upsell.
2. **Tag spelling.** Ipinapalagay na eksaktong `Add-ons` ang tag. Ibang spelling
   → mali ang filter sa **bawat** bouquet browse (laging naka-append ang
   `-tag:'Add-ons'`).
3. **Best-seller prefix match.** Tokenized ang title search ng Shopify, kaya ang
   `title:"Sweet Heart"` ay pwedeng tumama rin sa "Sweet Heart Deluxe";
   napupunta ito sa `extra` at ipinapakitang best seller.
4. **Alias override.** Pinapalitan ng buo ang area string sa whole-word hit,
   kaya ang "Maynila Street, Cavite" ay magiging manila at mawawala ang Cavite.
   (Constants ang aliases at walang regex metacharacter: walang injection risk.)

Manipis ang test coverage ng batch na ito: ang tool-registry name list at ang
caching block lang ang naka-pin. Ang sort, tags/exclude_tags, addons scoping,
best-seller ordering, `onlineStoreUrl` skip at alias expansion ay **walang
unit test**.
