# Messenger Chatbot: Complete File Inventory

> Snapshot na inventory ng buong Facebook Messenger chatbot ng FlowerCart app.
> Ginawa: 2026-08-28. Layunin: reference para sa file/code/config/docs/tests audit.
> **Ito ay Jhay's app** (flowercart.store); nasa repo na ito lahat; walang external na kopya.

---

## 1. Overview: paano gumagana

Isang Facebook Messenger AI agent na naka-embed sa Shopify app. Ang customer nagme-message
sa FB Page -> sinasagot ng LLM (Claude Sonnet) -> makakapag-browse ng bouquets, mag-check
ng delivery fee/coverage, mag-track ng order, at mag-place ng draft order, lahat sa loob ng chat.

**Design mantra (paulit-ulit sa code):** *"the LLM handles LANGUAGE; the code advances STATE."*
Ang AI ang bahala sa salita; ang code ang nagpapasya ng aktwal na order state (para hindi
mag-imbento ng order ang LLM).

**Dalawang layer** (hiniwalay 2026-08-24, ADR-20):
- `agent-*` = shared brain (channel-neutral, walang Meta I/O), reusable ng Messenger,
  customer-account chat, at storefront widget.
- `messenger-*` = Meta transport adapter; dito lang nangyayari ang usapan sa Facebook.

> **Status note (per memory):** ang chatbot ay HINDI pa live sa customers: bagsak pa ang
> Meta App Review (per 2026-08-21), kailangan pang magpasa ulit. Ang code ay tapos at
> naka-gate, pero hindi pa naa-activate publicly.

---

## 2. Paano naka-wire sa Meta / Facebook (ang aktwal na koneksyon)

Meta App ID `1065300189364788`. Ito ang ika-5 auth surface ng app; HINDI dumadaan sa
Shopify at HINDI naka-register sa `shopify.app.toml`. Naka-register sa Meta dashboard mismo.

| Hakbang | Endpoint / File | Detalye |
|---|---|---|
| 1. Webhook verify (setup) | `GET /webhooks/messenger` -> `webhooks.messenger.ts:73-93` | Chine-check `hub.mode=subscribe` + `hub.verify_token` vs `MESSENGER_VERIFY_TOKEN`, ie-echo ang `hub.challenge`. |
| 2. Webhook receive (inbound) | `POST /webhooks/messenger` -> `webhooks.messenger.ts:95-290` | Raw body muna, verify `X-Hub-Signature-256` (HMAC-SHA256, key=`MESSENGER_APP_SECRET`) via `verify-meta-signature.server.ts`. Tapos: dedupe by `MessengerMessage.mid` -> enqueue Cloud Tasks -> laging 200. |
| 3. Async worker | `POST /webhooks/messenger/worker` -> `webhooks.messenger_.worker.ts` | Cloud Tasks lang tumatawag. HMAC verify (key=`MESSENGER_WORKER_SECRET`, ika-6 auth surface) -> `processAgentTurnByMid()` -> send. |
| 4. Send API (outbound) | `messenger-send.server.ts:60-61` | `POST https://graph.facebook.com/v23.0/{MESSENGER_PAGE_ID}/messages` na may `Authorization: Bearer {MESSENGER_PAGE_ACCESS_TOKEN}`. Token nasa header lang, never sa URL. |
| 5. Profile setup | `messenger-profile.server.ts` | Get Started + Ice Breakers + Persistent Menu; one-time merchant-triggered mula `/app/messenger-orders`. |

- Graph API version naka-pin sa `v23.0` (`messenger-send.server.ts:11`); huwag i-float.
- Webhook mabilis mag-200; ang LLM+send work ay ipinapasa sa Cloud Tasks worker.
  Rationale: [decisions.md ADR-20](./decisions.md).

---

## 3. Routes (entry points)

| File | LOC | Purpose | Key lines |
|---|---|---|---|
| `app/routes/webhooks.messenger.ts` | 290 | Meta webhook: GET verify + POST receive/dedupe/enqueue | verify `:73`, signature `:110`, echo/human-takeover `:148`, quick-reply tap `:203`, image `:230`, 503-on-record-fail `:286` |
| `app/routes/webhooks.messenger_.worker.ts` | 109 | Cloud Tasks worker -> agent -> send | HMAC verify `:36`, follow-up `:58`, main turn `:83`, 503-retry `:99` |
| `app/routes/app.messenger-orders.tsx` | 1071 | Merchant admin page (thread pause/resume, orders list, widget config, profile setup) | GraphQL `tag:messenger` `:103`, loader `:170`, action 3 intents `:276`, WidgetConfigCard `:650` |

## 4. Meta transport adapters (`messenger-*`)

| File | LOC | Purpose | Key lines / notes |
|---|---|---|---|
| `app/services/messenger-orders.server.ts` | 1105 | Order slot-fill state machine + idempotent Shopify draft-order create | `updateMessengerOrderState` `:319`, `confirmMessengerOrder` `:854`, `buildOrderSummaryText` `:587`, draft tag `mo-key-<uuid>` |
| `app/services/messenger-agent.server.ts` | 743 | THE Messenger adapter: repliedAt dedupe, humanControl mute, CONFIRM tap, typing, blocks->primitives | `processAgentTurnByMid` `:393`, CONFIRM bypass `:447`, block translation `:503`, follow-up `:628` |
| `app/services/messenger-queue.server.ts` | 335 | Cloud Tasks enqueue layer (HMAC-signed) | `enqueueMessengerEchoTask` `:127`, `signWorkerPayload` `:37` |
| `app/services/messenger-coverage.server.ts` | 285 | In-process NCR coverage + fee estimate (walang external API sa hot path) | `checkDeliveryCoverage` `:195`, `haversineKm` `:31`, `estimateDeliveryFeePhp` `:44` |
| `app/services/messenger-send.server.ts` | 184 | Facebook Send API (plain fetch, walang SDK) | Graph POST `:60`, version `:11`, text `:126`, carousel `:148`, typing `:116` |
| `app/services/messenger-profile.server.ts` | 171 | Messenger Profile API (Get Started / Ice Breakers / Menu) | body shape `:26` |
| `app/services/messenger-events.server.ts` | 121 | Neon bookkeeping (record inbound, operator echo, dedupe) | consumed by webhook route |
| `app/services/messenger-agent-tools.server.ts` | 5 | Shim -> `export * from "./agent-tools.server"` | re-export lang |
| `app/services/messenger-llm.server.ts` | 6 | Shim -> `agent-llm.server` | re-export lang |
| `app/services/messenger-products.server.ts` | 5 | Shim -> `agent-products.server` | re-export lang |

## 5. Shared brain (`agent-*`, channel-neutral)

| File | LOC | Purpose | Key lines |
|---|---|---|---|
| `app/services/agent-tools.server.ts` | 717 | Tool registry + dispatcher (8 tools: date/slots/coverage/products/order/lookup) | `MESSENGER_AGENT_TOOLS` `:307`, `executeAgentTool` `:588`, `LOOKUP_MY_ORDERS_TOOL` `:554` |
| `app/services/agent-products.server.ts` | 523 | Live Shopify product search / best-sellers / variant re-validate | `searchShopProducts` `:348`, `getVariantLive` `:495`, fuzzy typo match `:177` |
| `app/services/agent-core.server.ts` | 365 | Transport-free brain: runs 1 LLM tool-loop turn -> neutral `AgentBlock[]` | `runAgentTurn` `:129`, dual ordering gate `:149`, `MAX_LLM_ITERATIONS=5` `:58` |
| `app/services/agent-prompt.server.ts` | 225 | System prompt + text hygiene | `buildStaticSystemPrompt` `:64`, `sanitizeMessengerText` `:217`, `messengerOrdersEnabled` `:26` |
| `app/services/agent-channel.ts` | 147 | Types-only channel contract (no I/O) | `MESSENGER_CAPABILITIES` `:115` (tanging may `ordering:true`), `AgentBlock` union `:85` |
| `app/services/agent-llm.server.ts` | 121 | Lone LLM provider interface (Anthropic SDK boundary) | `runLlmTurn` `:65`, model `claude-sonnet-5` `:16`, prompt-cache `:82` |
| `app/services/agent-rate-limit.server.ts` | 62 | Per-caller turn-rate limiter (storefront guard, hindi Messenger) | `checkAndRecordAgentRateLimit` `:26` |

**Supporting shared (agent-consumed):**
- `app/services/order-lookup.server.ts`: read-only order tracking (`lookupOrderByNameAndZip` `:225`) + anti-guessing lockout (`isLookupLocked` `:383`)
- `app/services/faq-facts.server.ts`: merchant KB Q&A grounding (`loadFaqFacts` `:57`; gated OFF sa Messenger)
- `app/services/cod-facts.server.ts`: COD fee/cap sa prompt (`loadCodFacts` `:59`)
- `app/lib/verify-meta-signature.server.ts` (31): HMAC-SHA256 timing-safe verify (`:12`)

## 6. Config / env: `.env.example`

| Var | Line | Gamit |
|---|---|---|
| `MESSENGER_APP_SECRET` | 26 | HMAC verify ng inbound `X-Hub-Signature-256` |
| `MESSENGER_VERIFY_TOKEN` | 27 | GET handshake `hub.verify_token` |
| `MESSENGER_PAGE_ACCESS_TOKEN` | 28 | Send API bearer token |
| `MESSENGER_PAGE_ID` | 29 | Page id sa Send URL |
| `MESSENGER_TASKS_QUEUE_PATH` | 30 | Cloud Tasks queue |
| `MESSENGER_WORKER_URL` | 31 | Worker route URL |
| `MESSENGER_WORKER_SECRET` | 32 | HMAC key ng worker |
| `MESSENGER_SHOP` | 33 | Shop domain para sa `unauthenticated.admin()` |
| `MESSENGER_FOLLOWUP_HOURS` | 34 | Abandoned-order follow-up delay |
| `ANTHROPIC_API_KEY` | 35 | LLM key |

- Real values ay nasa Google Secret Manager, hindi sa repo.
- Walang Messenger webhook sa `shopify.app.toml` / `shopify.app.production.toml` (nasa Meta dashboard).
- GAP: `MESSENGER_ORDERS_ENABLED` at `MESSENGER_HANDBACK_HOURS` ay ginagamit ng code pero
  WALA sa `.env.example`; dapat idagdag.

## 7. Data model: `prisma/schema.prisma`

| Model | Lines | Gamit |
|---|---|---|
| `MessengerThread` | 39-65 | Per-customer thread: `psid` PK, `humanControl`, `disclosedBot`, `orderStateJson` (slot-fill), `conversationOrderKey` (idempotency) |
| `MessengerMessage` | 92-106 | Per-message log: `mid @unique` (webhook dedupe), `role`, `repliedAt`, `replyMid` |
| `LookupAttempt` | 73-78 | Channel-agnostic order-lookup lockout (pumalit sa 2 dead columns sa MessengerThread) |
| `AgentRateLimit` | 85-90 | Turn-rate counter |
| `WidgetConfig` | 316-344 | Storefront widget config (edited sa messenger-orders admin page) |

**Migrations:** `20260801000000_add_messenger_thread_message`, `20260802000000_add_messenger_order_state`,
`20260821000000_add_lookup_attempt_limit` (dead na), `20260821020000_add_lookup_attempt`,
`20260822000000_add_agent_rate_limit`, `20260823000000_add_widget_config`.

> Dead columns: `MessengerThread.lookupFailures` + `lookupLockedAt`; hindi na binabasa
> (superseded ng `LookupAttempt`), iniwan (destructive mag-drop).

## 8. Docs

| File | LOC | Laman |
|---|---|---|
| `docs/messenger-progress.md` | 671 | Phase-by-phase build log (Phase 2->13); config table `:216`; Phase 13 hindi pa deployed |
| `docs/messenger-testing-runbook.md` | 106 | Manual smoke-test steps (webhook verify, token regen, echo gate, thread routing) |
| `docs/architecture.md` | N/A | Messenger flow `:24`; channel abstraction `:32-44`; ERD `:213-237` |
| `docs/api.md` | N/A | Meta webhook section `:169`; auth-surface intro `:18`; shared code `:319` |
| `docs/decisions.md` | N/A | ADR-20 (multi-channel) `:358`; ADR-21/22 (reuse worker) `:405`/`:439` |

## 9. Tests (17 files, ~7064 LOC; halos 1.4:1 test-to-code)

**Messenger-specific:**
- `test/webhooks-messenger-route.test.ts` (686)
- `test/webhooks-messenger-worker.test.ts` (169)
- `test/verify-meta-signature.server.test.ts` (60)
- `test/messenger-send.server.test.ts` (304)
- `test/messenger-queue.server.test.ts` (288)
- `test/messenger-events.server.test.ts` (145)
- `test/messenger-agent.server.test.ts` (1416)
- `test/messenger-orders.server.test.ts` (987)
- `test/messenger-profile.server.test.ts` (196)
- `test/messenger-coverage.server.test.ts` (172)
- `test/app-messenger-orders-route.test.ts` (512)

**Shared brain:**
- `test/agent-core.server.test.ts` (909)
- `test/agent-tools.server.test.ts` (510)
- `test/agent-products.server.test.ts` (362)
- `test/agent-llm.server.test.ts` (139)
- `test/agent-rate-limit.server.test.ts` (110)
- `test/agent-block-contract.test.ts` (99)
- `test/order-lookup.server.test.ts`

---

## 10. Buod: grand total

| Layer | Files | LOC |
|---|---|---|
| Routes | 3 | 1470 |
| Messenger adapters | 10 | 2960 |
| Shared brain | 7 | 2160 |
| Lib | 1 | 31 |
| Tests | 17 | 7064 |
| Docs | 2 | 777 |
| **TOTAL** | **~40 files** | **~14462 LOC** |

**3 bagay na dapat bantayan:**
1. Chatbot HINDI pa live; pending Meta App Review re-submission.
2. `MESSENGER_ORDERS_ENABLED` + `MESSENGER_HANDBACK_HOURS` WALA sa `.env.example`.
3. 2 dead columns sa `MessengerThread` (`lookupFailures`, `lookupLockedAt`).
