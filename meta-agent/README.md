# meta-agent/ — Business AI configuration assets

Shared na folder ng assets para sa pag-configure ng **Business AI** (Meta Business
Suite AI assistant) ng The Flowercart. Ito ang mga file na i-fu-feed / i-cocopy-paste
sa Business AI knowledge o custom instructions.

## Laman

| File | Ano | Pinagmulan |
|---|---|---|
| `knowledge-base-qa.md` | 64 na Question & Answer pairs — buong live FAQ + delivery coverage per city/town | Live Shopify Knowledge Base metaobject `shopify--qa-pair` |
| `meta-load-log.md` | Talaan ng aktwal na na-load sa Business AI + ang title-dedup na trap | Session log |

## Paano ni-pull

Direkta sa LIVE Shopify Admin API gamit ang Shopify connector (metaobject
`shopify--qa-pair`, fields: `question`, `answer`, `sources`). **Verbatim** ang teksto
ng sagot mula sa live KB — ito ang source of truth, hindi ang lumang
`docs/flowerbot-training-data.md`.

- **Pull date:** 2026-08-28
- **Count:** 64 Q&A pairs (36 general FAQ + 17 city coverage + 4 provincial + 7 bago:
  tracking, reschedule, COD, holiday pricing, area check, bouquet change)

## Pag-update

Kapag may binago sa Shopify KB, i-re-pull ulit ang metaobject at palitan ang
`knowledge-base-qa.md`. Sabihin lang: "i-refresh ang meta-agent KB".
