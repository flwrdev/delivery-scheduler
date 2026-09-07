# Business AI knowledge load log

Talaan ng mga aktwal na na-load sa **Meta Business Agent → Your info → Add info**
(business_id `931323377335096`, asset_id `105284684761365`). Basahin muna ito bago
mag-load ulit para hindi madoble.

## 2026-08-28 — unang buong load mula sa `knowledge-base-qa.md`

- **Source:** `knowledge-base-qa.md` (43 Q&A + 21 coverage blocks)
- **Naging 66 na entries:** Title = tanong / label ng lungsod, Details = **verbatim**
  na sagot. Hinati ang Quezon City sa 3 parts (2000-char cap ng Details field).
- **65 ang pumasok at na-verify.** Hindi na inulit ang isa (tingnan sa baba).
- **Walang binura** sa mga dating entries.

### Ang title-dedup na trap

Tahimik na tinatanggihan ng Meta ang bagong entry kapag masyadong kamukha ang
**Title** ng isang existing entry — lumalabas pa rin ang "Your changes have been
saved", nagsasara ang dialog, pero **walang naili-save**. Ang Details ay hindi
sinusuri; ang Title lang. Napatunayan: `"Do you deliver to PO boxes?"` tinanggihan,
pero ang **eksaktong parehong sagot** sa ilalim ng `"PO box delivery policy"` ay
pumasok agad.

Kaya 12 entries ang kinailangang bigyan ng bagong Title (**verbatim pa rin ang sagot**):

| KB question | Title na ginamit sa Meta |
|---|---|
| How do i know if my order is confirm? | Order confirmation email after placing an order |
| It is possible to make reservation for an order? | Pre-order and reserve a preferred delivery date and time slot |
| Do you provide product quatations? | Quotations for bulk orders and corporate orders |
| When will flower arrive? | Arrival time within your chosen delivery time slot |
| How will the flower arrive? | How the bouquets are transported by our drivers |
| How do i know that my flowers were delivered? | Delivery confirmation email once the flowers are delivered |
| Can you ensure that you hand over directly to my recipient? | Handing the flowers over directly to the recipient |
| Do you deliver to PO boxes? | PO box delivery policy |
| What happen if i provide incorrect delivery details? | Incorrect delivery details and the re-delivery fee |
| Why is the flower is different from what i see on your website and social media? | Why the bouquet received may differ from website photos |
| I received the wrong bouquet can you send me the right one? | Received the wrong bouquet - what to do |
| Can i request return refund after the day of delivery? | Returns and refunds window after the day of delivery |

### Hindi ipinasok

- **"Is your business is registered with the BIR?"** — may existing entry na
  (`"Is your business registered with the BIR?"`) na ang laman ay **eksaktong-eksakto**
  na ang sagot sa KB. Duplicate lang ang maidaragdag.

### Bukas na desisyon

Ang 12 reworded entries ay **kasabay** ngayon ng mas luluma at mas maiikling entries
sa parehong paksa (hal. `"How are the flowers delivered?"` na putol ang huling
pangungusap). Sinadya iyon — bawal magbura. Kung magkasalungat ang sagot ng AI,
diyan tingnan.

### Paano na-verify

Bawat entry hinanap isa-isa sa Search info (naka-cap sa 10 ang resulta, kaya hindi
puwedeng pangkatan) — 65/65 present. Sinuri rin ang Details ng pinakamahahabang
entries (Quezon City part 1, Makati, "Can i cancel order?") gamit ang checksum laban
sa source file — tugma nang byte-for-byte, walang truncation.

## 2026-08-29 — paglilinis ng salungatan sa mga lumang entry

Matapos ang load, sinuri ang mga lumang entry (chat-voice Taglish, para sa Messenger)
laban sa KB. Nakita: **hindi lang duplikasyon ang problema, kundi magkasalungat na
datos.** Mga desisyon ng merchant at ang ginawa:

### Pinagsama (KB answer ang nanalo, orihinal na pamagat ang nanatili)

Dalawang lumang entry ay putol lang na bersyon ng KB answer. Ginawang buo ang laman
ng LUMA (para hindi mabali ang anumang umaasa sa pamagat nito), tapos binura ang
duplicate na reworded na entry:

- `How are the flowers delivered?` — 99 → 205 chars
- `What happens if the recipient is not available during delivery?` — 149 → 438 chars
- Binura: `How the bouquets are transported by our drivers`, `Handing the flowers over
  directly to the recipient`

### Channel scoping — HINDI mali ang 2-3 hours

Ang `Q: Gaano katagal bago ma-deliver?` ay nangangako ng 2-3 oras. Ayon sa merchant,
**totoo ito**: naka-tutok sila sa chat, kaya puwedeng i-hand-off ng agent ang high-intent
na usapan at hindi na dumaan sa Shopify order na may fixed na time slot; kayang abutin
ang Laguna (pinakadulo ng coverage) sa loob ng tatlong oras. Kaya hindi ito binura —
nilinaw lang kung aling channel:

> Ito po ang para sa on-demand na order na inaayos namin dito sa chat. Kapag sa website
> po kayo nag-order at pumili ng delivery time slot, sa napili ninyong slot po ihahatid
> — hindi po sa loob ng 2-3 hours.

**Aral:** ang chat channel ay may mas maluwag na katotohanan kaysa website flow. Bago
"itama" ang isang lumang chat entry, tanungin muna — baka totoo ito sa ibang channel.

### Itinama (desisyon ng merchant)

| Entry | Dati | Ngayon |
|---|---|---|
| `Anong oras po usually ang delivery?` | 8AM–11PM | 9AM–11PM (para consistent sa Shopify at makabuo ng tiwala) |
| `Is cash on delivery available?` | ₱2,000 pababa; COD sa Bacoor/Antipolo/Imus/Kawit/Meycauayan/Bocaue/Guiguinto; ₱50 sa Malabon | MM lang, hanggang ₱2,500, ₱70 handling fee |
| `Is there a limit for COD?` | MM + Cavite/Rizal/Bulacan, **minimum** na ₱2,500 | MM lang, hanggang ₱2,500 (**maximum**), ₱70 |

Ang "minimum" ay baliktad ng KB (₱2,500 ang **maximum**) — ibig sabihin puwedeng
tanggihan ng AI ang isang ₱1,500 na COD order na dapat ay tanggap.

### Binura

- `Pwede po ba mag-pickup ng order?` (`yes pwede po! here po pick up address: 255 kawit
  st. manila`) — **may pickup talaga sila sa chat**, pero ipinabura ng merchant para
  iwas drift sa docs. ⚠️ Bunga nito: sasagot na ngayon ang AI mula sa `Do you have retail
  store locations?` (`We are online flower shop`), kaya epektibong itatanggi nito ang
  pickup. Kung babalikan, magdagdag ng neutral na by-request na linya.

### Sinuri at sadyang iniwan (desisyon ng merchant, 2026-08-29)

- **Address:** nananatili ang `255 Kawit St, Tondo, Manila` sa `What is your location?`
  at `Saan po kayo located?`. Ang inalis ay ang ALOK ng pickup, hindi ang address —
  lehitimong tanong ang lokasyon, at nasa KB na rin ang Tondo bilang pickup point ng
  fee computation. **Huwag itong alisin sa susunod na paglilinis.**
- **Pangalan ng courier:** OK lang banggitin ang Lalamove/Grab sa customer
  (`Ano po ang mga courier...`, `What is your shipping policy?`, `Q: Gaano katagal...`).
  Nakakadagdag ito ng tiwala. Tahimik ang KB tungkol dito — hindi salungatan, hindi
  lang pare-pareho, at sinadya iyon.
- **Mojibake:** may `` sa pamagat ng ilang lumang entry (hal. `Is cash on delivery
  available?`). Kosmetiko lang, hindi ginalaw.
