# Proposal: Durable job rows para sa webhook sync at bulk ops (M1 + S5 + S4)

> Status: **APPROVED ng merchant ang direksyon at schema design (2026-08-26)
> — hindi pa naka-code.** Galing sa 2026-08-26 Orders Ops code review; ang
> tatlong finding na ito ay sinadyang i-defer ng merchant para pagplanuhan
> muna ang tunay na ugat. Mga desisyon ng merchant (2026-08-26): **threshold
> na ≤10 inline** at **KASAMA ang Phase C** (§5), plus DALAWANG binding
> constraint sa implementation — **(1) walang double-processing, (2) ang
> bayad na order ay hindi kailanman ire-reject dahil lumagpas na ang cutoff
> sa oras ng retry** — nakadetalye sa §2a. Kapag na-implement: ito ay
> magiging ADR sa decisions.md at ia-update ang architecture.md + api.md +
> orders-ui.md.

## 1. Ang tunay na ugat ng problema

Iisa ang sakit ng M1, S5, at S4: **isang HTTP request ang hawak ang sobrang
daming upstream na trabaho, at kapag naputol ito sa gitna, walang naiiwang
rekord kung ano ang natapos at ano ang hindi.** Walang makaka-resume dahil
walang nakasulat kahit saan na may trabahong naiwan.

### 1a. `webhooks.orders.create.ts` (M1 + S5)

Isang webhook invocation ang gumagawa ng hanggang ~6 na sunud-sunod na
upstream operation: offline session lookup → COD fee (order edit begin +
commit) → schedule rules + live booked-count scan → `metafieldsSet` (delivery
metafields) → `tagsAdd` (schedule tag). Ang bawat failure path ngayon ay
`console.warn` + **200 ack** — hindi na kailanman babalikan:

| Failure ngayon | Kinalalabasan |
| --- | --- |
| Neon cold start sa schedule-rules read | **Buong sync na-skip nang tuluyan** — walang metafields, walang tag, 200 ack (pinakamasamang kaso ng M1) |
| `syncOrderDeliveryMetafields` pumalya, tags nag-succeed | Order na may schedule tag pero **walang `custom.date`** (S5 partial) |
| Metafields nag-succeed, tag sync pumalya | Kabaligtaran na partial (S5) |
| COD fee pumalya | Nawalang ₱70 fee, log line lang ang bakas |

Ang epekto ng M1 ay hindi lang kosmetiko: ang booked-slot counts ay live na
hinahanap sa `metafields.custom.date` — ang order na hindi na-sync ay
**hindi nabibilang sa capacity**, kaya puwedeng ma-overbook ang slot.

### 1b. Bulk action sa `app.orders.tsx` (S4)

Isang POST ang nagpoproseso ng hanggang 100 orders nang sequential. Ang
pinakamabigat na ops: `reschedule` (bawat order = multi-write via
`rescheduleOrderDelivery`: metafields + mirrors + tags + attributes +
history) at `markFulfilled` (batch query + per-order `fulfillmentCreate` +
tag pass + Lalamove record). Sa ~300–600ms bawat Admin API call, ang
100-order reschedule ay ilang minuto — lalampas sa pasensya ng embedded
fetcher at ng Cloudflare (ADR-11: ang 504 ay pinapalitan ng Cloudflare ng
sarili nitong HTML kaya sira ang response). Ang server ay patuloy na
nagmu-mutate habang patay na ang koneksyon: kalahati tapos, kalahati hindi,
at **walang rekord kung alin ang alin**.

## 2. Ang hugis ng solusyon

**Durable job rows sa Postgres + ang dalawang async rail na MAYRoon na ang
repo.** Walang bagong imprastraktura ang kailangan:

- **Cloud Tasks** — ang `SupportChatJob` enqueue-then-poll pattern
  (`messenger-queue.server.ts` na may shared `postMessengerTask` core, HMAC
  worker auth, at inline fallback kapag walang queue sa dev).
- **Cloud Scheduler** — ang poller/sweep pattern (`internal.lalamove-poll`
  kada 10 min, nightly retention purge).

**Posture guard (mahalaga):** ang mga bagong table ay **work bookkeeping
lang, hindi delivery state.** Ang Shopify order ang nananatiling ledger
(CLAUDE.md rule). Ang mga row ay transient — sasama sa nightly retention
purge kapag tapos na.

Ang prinsipyo sa lahat ng dako: **bawat HTTP request ay maliit** — tumanggap,
magsulat ng row, mag-enqueue, umalis. Ang mabigat na trabaho ay laging may
row na nakatala BAGO ito simulan, kaya kahit mamatay ang attempt, may
makaka-resume.

## 2a. Dalawang binding constraint (merchant, 2026-08-26)

### (1) Walang double-processing

May live scar na ang repo dito: noong 2026-08-02, ang 30s na
`dispatchDeadline` ay nagdulot ng TOTOONG duplicate replies sa Messenger —
nag-redispatch ang Cloud Tasks habang tumatakbo pa ang unang attempt, at
parehong nakapagpadala bago naisulat ang `repliedAt` (nakadokumento sa
`messenger-queue.server.ts`). Kaya ang disenyong ito ay hindi aasa sa
deadline tuning lang; tatlong sapin ang bakod:

- **Row lease (claim-before-work):** may `lockedAt` column ang parehong work
  table. Ang worker ay kumakapit muna sa row gamit ang conditional
  `updateMany` (status ay `pending`/`queued` PA at `lockedAt` ay null o
  stale na lampas sa lease window, hal. 5 min) — kapag 0 rows ang na-update,
  may ibang worker nang may hawak: **umalis agad nang walang ginagalaw.**
  Ito ang bakod laban sa sabayang attempt (Cloud Tasks redispatch, sweep na
  nakasabay sa live task, dalawang chunk chain ng iisang job). Sa bulk
  chunking, nire-renew ang lease sa bawat chunk.
- **Per-item conditional claim (bulk):** bago iproseso ang isang
  `BulkActionJobItem`:
  `updateMany({ where: { id, status: "pending" }, data: { status: "processing" } })`
  — 0 rows = inangkin na ng iba, laktawan. Kahit magkasabay ang dalawang
  worker sa iisang job, bawat order ay mapoproseso nang minsanan lang.
- **Idempotent steps sa Shopify side bilang huling sapin:** `metafieldsSet`
  = set semantics (parehong value, walang epekto ang ulit); `tagsAdd` =
  add-if-absent; ang COD fee guard (already-applied check) ay dapat
  ma-verify sa implementation na protektado ng lease ang check-then-act
  window nito; `fulfillmentCreate` re-run ay hinaharang ng fulfillmentOrders
  re-check; `reschedule` ay may skip-if-already-at-target guard (§3b). Kung
  sakaling makalusot pa rin ang isang duplicate attempt, ang worst case ay
  isang redundant na write ng parehong value — hindi dobleng fee, hindi
  dobleng fulfillment, hindi dobleng history entry.

### (2) Ang bayad na order ay hindi kailanman ire-reject dahil sa cutoff

Ito ang D4 semantics na umiiral na sa webhook ngayon (audit DEF-7) at
OBLIGADONG madala nang buo sa retry design: **ang validation ay flag, hindi
gate** — laging itutuloy ang sync ng bayad na order, at ang kinalabasan ng
validation ay naitatatak lang sa `delivery.sync_status`
(`"ok" | "attention:<code>"`) para makita ng merchant, hindi kailanman
hinaharang ang write.

Ang kritikal na dagdag dahil may retries na: **ang validation clock ay ang
nakaimbak na `checkoutTime` sa task row, hindi kailanman ang oras ng
retry.** Ang order na legal na naka-checkout bago mag-cutoff ay hindi
magiging "lampas sa cutoff" dahil lang naantala ang sync nang ilang minuto o
oras — ito mismo ang dahilan kung bakit naka-snapshot ang `checkoutTime` sa
schema. Ang capacity ay advisory pa rin (`attention:capacity`), hindi
rejection. **Walang kahit anong path sa disenyong ito na magre-reject o
mag-iiwan ng bayad nang order na walang delivery sync.**

## 3. Schema design

Dalawang purpose-specific na model (hindi generic queue) — tugma sa
precedent ng repo (`LalamoveTracking`, `SupportChatJob`, `OccasionReminder`
ay pawang purpose-specific side tables), at magkaiba talaga ang lifecycle ng
dalawang workload.

### 3a. `DeliverySyncTask` — para sa M1 + S5

```prisma
// Webhook delivery-sync na may utang na trabaho. Work bookkeeping LANG —
// ang Shopify order pa rin ang delivery-state ledger. Ang row ay ang
// "resume point": alam nito kung aling step ang tapos na (S5) at kailan
// susubukan ulit (M1).
model DeliverySyncTask {
  id             String    @id @default(cuid())
  shop           String
  shopifyOrderId String
  orderName      String?   // "#1046" — pang-display sa merchant banner
  // Work input, na-extract nang isang beses mula sa webhook payload —
  // hindi na kailangang hulihin ulit ang payload sa retry.
  deliveryDate   String?   // null = COD-fee-only na task (walang delivery attrs)
  timeSlot       String?
  checkoutTime   DateTime  // checkout-time semantics ng validation (D4)
  // S5: per-step ledger. Bawat step ay idempotent sa Shopify side
  // (metafieldsSet = set, tagsAdd = add-if-absent, COD fee ay may sariling
  // already-applied guard) kaya ang retry ay inuulit lang ang hindi pa tapos.
  needsCodFee    Boolean   @default(false)
  metafieldsDone Boolean   @default(false)
  tagsDone       Boolean   @default(false)
  codFeeDone     Boolean   @default(false)
  status         String    @default("pending") // pending | done | failed
  // Double-processing guard (§2a): lease claim ng worker via conditional
  // updateMany — null o stale (>5 min) = puwedeng angkinin.
  lockedAt       DateTime?
  attempts       Int       @default(0)
  nextAttemptAt  DateTime  @default(now())
  lastError      String?   // huling dahilan ng kabiguan — makikita sa banner
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  doneAt         DateTime?

  @@unique([shop, shopifyOrderId]) // webhook redelivery → parehong row, hindi duplicate
  @@index([status, nextAttemptAt]) // ang sweep query
  @@index([shop, status])          // ang merchant-banner count query
}
```

**Bagong daloy ng webhook (payat na):**

1. `authenticate.webhook` → i-parse ang payload, i-extract ang attrs
   (puro lokal, walang upstream call).
2. **Upsert ng `DeliverySyncTask` row** (pending). Ito ang tanging
   kritikal na write.
3. I-enqueue sa Cloud Tasks (`{taskId}`); kapag walang queue (local dev) →
   iproseso inline — eksaktong parehong fallback ng support chat.
4. Mag-200 agad.

Kung ang Prisma upsert mismo ang pumalya (Neon talagang patay): **500 ang
isasagot** — may sariling retry si Shopify sa non-200 na webhook, kaya iyon
ang huling-hanay na safety net. Rare case lang ito (ang paulit-ulit na 5xx
ay nagpa-flag ng subscription, kaya hindi ito ang primary mechanism —
ang row + queue ang primary).

**Worker** (bagong route, hal. `webhooks.delivery-sync-worker`, HMAC-signed
gamit ang parehong `signWorkerPayload` pattern): kukunin ang row,
tatakbuhin ang mga step na hindi pa tapos (rules read kasama na rito —
kaya ang Neon cold start ay isang retry na lang, hindi tuluyang pagkawala),
tsi-nick ang bawat `*Done` flag pagka-succeed. Buo ang tagumpay → `done`.
May pumalya → `attempts++`, `nextAttemptAt` = backoff, at non-200 sa Cloud
Tasks para ang queue retry policy ang bahala sa pacing. Lampas sa
MAX_ATTEMPTS (~8 sa loob ng ~24h) → `failed`.

**Sweep** (maliit na addition sa Cloud Scheduler — hourly): dadamputin ang
mga `pending` na row na lampas na ang `nextAttemptAt` pero walang buhay na
task (naubos ang Cloud Tasks retries, o nawala ang task), ire-re-enqueue.
Belt-and-suspenders lang ito, hindi ang primary path.

**Merchant visibility (ang lunas sa "silent"):** ang `/app/orders` loader ay
magbibilang na rin ng `failed` (at matagal nang `pending`) na rows sa loob
ng existing guarded enrichment nito → Banner sa page: *"May N order na hindi
pa na-sync ang delivery info — I-retry"* na may retry action. Hindi na
kailanman mawawala nang tahimik.

### 3b. `BulkActionJob` + `BulkActionJobItem` — para sa S4

```prisma
// Isang malaking bulk op = isang job na may per-order items. Ang HTTP
// request ay nagsusulat lang ng rows at nag-e-enqueue; ang worker ang
// gumagawa, chunk-by-chunk, na may checkpoint sa bawat item.
model BulkActionJob {
  id          String    @id @default(cuid()) // ibinabalik sa client para sa polling
  shop        String
  action      String    // BulkActionName ("archive" | ... | "reschedule")
  paramsJson  String    // op inputs: tags / cancel reason+restock+notify /
                        // reschedule date+slot+override / trackingUrl+notify
  status      String    @default("queued") // queued | running | done | failed
  // Double-processing guard (§2a): job-level lease, nire-renew kada chunk;
  // ang mga item ay may sariling conditional claim (pending → processing).
  lockedAt    DateTime?
  totalCount  Int
  okCount     Int       @default(0)
  failCount   Int       @default(0)
  createdAt   DateTime  @default(now())
  startedAt   DateTime?
  finishedAt  DateTime?
  updatedAt   DateTime  @updatedAt
  items       BulkActionJobItem[]

  @@index([shop, status, createdAt])
}

model BulkActionJobItem {
  id             String   @id @default(cuid())
  jobId          String
  shopifyOrderId String
  orderName      String?  // pang-display sa results table
  status         String   @default("pending") // pending | processing | ok | failed
  message        String?  // parehong per-item message shape ng BulkActionItemResult
  updatedAt      DateTime @updatedAt
  job            BulkActionJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, shopifyOrderId])
  @@index([jobId, status])
}
```

**Daloy:**

- **Maliit na selection (≤ INLINE_MAX, hal. 10):** eksaktong kagaya ngayon —
  sync na sagot, walang job row, mabilis ang UX. *(Design fork #1 sa §5.)*
- **Malaking selection:** ang action ay gagawa ng job + items, mag-e-enqueue,
  at agad magsasagot ng `200 + { ok: true, mode: "job", jobId }` —
  ADR-11-compliant, hindi na kailanman aabutin ng timeout.
- **Anti-drift na kondisyon (obligado):** ang mga per-op executor ay
  i-e-extract sa iisang shared function na tatawagin ng PAREHONG inline path
  at worker — parehong prinsipyo ng REC-1/REC-2 (`rescheduleOrderDelivery`
  extraction) para hindi maaaring mag-iba ang dalawang landas.
- **Worker na may cooperative chunking:** ang `dispatchDeadline` ng shared
  Cloud Tasks core ay 180s — hindi kasya ang 100-order reschedule. Kaya ang
  worker ay magpoproseso lang ng hanggang CHUNK (hal. ~15 items o ~120s na
  budget), magche-checkpoint sa bawat item row, saka **ire-re-enqueue ang
  sarili** (parehong jobId) at mag-200. Uulit ang chain hanggang maubos ang
  `pending` items. Bawat HTTP request ay nananatiling maliit — mismong
  prinsipyo ng proposal na ito. Ang worker crash sa gitna ay ligtas: ang
  Cloud Tasks redispatch ay magre-resume sa `pending` items lang.
- **Idempotency per op:** `orderClose`/`orderOpen`/`tagsAdd`/`tagsRemove` —
  likas na idempotent; `markFulfilled` — ang re-run ay nagre-re-check ng
  fulfillmentOrders (ang "No fulfillable items remaining" ay nagiging ok/skip);
  `orderCancel` — ang "already cancelled" na userError sa retry ay ituturing
  na ok; `reschedule` — dagdag na guard: kapag ang order ay nasa target na
  date+slot na, skip (iwas duplicate history entry sa retry).
- **Client UX:** ang `useBulkActions` ay magkaka-job mode — sa
  `mode: "job"`, magpo-poll sa bagong authenticated fetcher route
  (`app.orders_.bulk-job.$id`) kada ~2s; progress sa modal
  ("34/100 naproseso…"); pagka-`done` → parehong toast + per-item results
  table na kagaya ngayon + revalidate. Ang smart-refresh ay naka-pause na
  habang `actionInFlight` — isasama ang poll phase doon.
- **Retention:** ang tapos nang jobs ay sasama sa existing nightly
  chat-retention purge (7 araw).

## 4. Mga phase ng rollout

| Phase | Laman | Sinasara |
| --- | --- | --- |
| **A** | `DeliverySyncTask` migration + payat na webhook + worker + sweep + merchant banner | **M1 + S5** |
| **B** | `BulkActionJob`/`Item` migration + executor extraction + chunked worker + client polling | **S4** |
| **C** *(opsyonal)* | Ang booked-count engine ay bibilangin DIN ang `pending` sync tasks (shop+date+slot) bilang booked — sarado ang capacity-undercount kahit sa loob mismo ng retry window | Ang huling butas ng M1 |

Ang Phase C ay hihipo sa availability engine (malapit sa SENSITIVE na
coverage/fee na single-source-of-truth) kaya hiwalay itong desisyon.
Additive ito, hindi caching — ginagawa nitong MAS tama ang counts, hindi
pinapalitan ang live scan.

Bawat phase: bagong migration → sabihan ang merchant na
`npm run setup` bago ang susunod na `npm run dev` (per CLAUDE.md rule).
Bagong env: `OPS_WORKER_SECRET` (worker HMAC — hiwalay sa
`MESSENGER_WORKER_SECRET` para hiwalay ang blast radius); merchant-only
step per deploy runbook.

## 5. Mga design fork (desisyon ng merchant)

1. **Bulk threshold:** inline pa rin ang ≤10 orders + async lang ang lampas
   (recommended — snappy ang karaniwang kaso, at protektado ng shared
   executor laban sa drift) **o** always-async lahat (iisang code path,
   pero lahat ng maliliit na ops ay magkaka-polling latency)?
2. **Phase C:** isama sa plano (recommended — ito ang tunay na sarado ng
   capacity hole ng M1) **o** huwag muna (Phase A pa rin ang magpapaliit
   nang malaki sa window)?
3. *(Rekomendasyon na lang, hindi tanong: hiwalay na Cloud Tasks queue
   `delivery-scheduler-ops` imbes na makisabay sa Messenger queue — para
   ang retry policy ng chat ay hindi nakatali sa retry policy ng ops.)*
