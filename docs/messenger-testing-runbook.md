# Messenger Agent — Manual Testing Runbook (operator steps)

> Para sa human operator: lahat ng manual smoke tests at Meta-dashboard checks,
> step-by-step. **Walang secret values dito** — placeholder lang; ang values ay
> nasa Google Secret Manager / Meta dashboard.
>
> Constants: Cloud Run service `delivery-scheduler`, region `us-central1`,
> project `lalamove-map`. Page: The Flowercart (`105284684761365`).
> Webhook URL: `https://delivery-scheduler-299861709433.us-central1.run.app/webhooks/messenger`

---

## 1. Webhook smoke test (GET verify handshake)

Sa PowerShell (palitan ang `<VERIFY_TOKEN>` ng laman ng `messenger-verify-token` secret —
huwag i-paste sa chat, sa terminal mo lang):

```powershell
curl.exe "https://delivery-scheduler-299861709433.us-central1.run.app/webhooks/messenger?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=12345"
```

- **Expected:** `12345` ang lalabas.
- Maling token → walang body, HTTP 403. Kung 403 kahit tama ang token,
  baka may trailing space/newline sa secret value.

## 2. Basahin ang webhook logs (pwede mong patakbuhin mismo)

```powershell
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=delivery-scheduler AND textPayload:"[messenger]"' --project lalamove-map --freshness 1h --limit 20 --format "value(timestamp,textPayload)"
```

Mga makikita mo:

| Log line | Ibig sabihin |
|---|---|
| `entry shape: messaging=1 standby=0` | ✅ Tayo ang primary receiver — dumadating ang event sa atin |
| `entry shape: messaging=0 standby=1` | ❌ Ibang app (Inbox/Manychat) ang may hawak ng thread |
| `skipped event: keys=...postback` | Normal — buttons/postbacks hindi ine-echo |
| `echoed mid=... reply=...` | ✅ **GATE PASSED** — nakapag-send ang bot |
| `echo send failed: Graph API <code>: ...` | ❌ Pumalya ang outbound send — itala ang exact error |

## 3. Dashboard Send API test (i-isolate ang outbound path)

Ginagamit ito kapag pumapalya ang send natin — tinitignan kung gumagana ang token
sa LABAS ng code natin.

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** → piliin ang app (flowercartbot).
2. Left sidebar → **Messenger** → **Messenger API Settings** (a.k.a. API Setup).
3. Hanapin ang **"Get started using the API"** / send-message tool.
4. Sa **To** dropdown: piliin ang sarili mong account (lalabas ito dahil recent
   kang nag-message sa page). Kung walang laman ang dropdown → mag-send ka muna
   ng kahit anong message sa page sa Messenger, tapos i-refresh.
5. Message type **Text**, ilagay `Hello World`, i-send (o kopyahin ang cURL nila
   at patakbuhin sa terminal mo — HUWAG i-paste ang cURL output/token sa chat).
6. Tignan ang Messenger mo.

**Resulta:**
- **Dumating ang message** → malusog ang token; ang bug ay sa call ng code natin
  (hal. Graph version pin). Sabihin kay Claude → babaguhin ang code.
- **Hindi dumating / may error** → token o page-connection issue → gawin ang §4.

## 4. I-regenerate ang page access token

1. Messenger API Settings → **Generate access tokens** section → row ng
   **The Flowercart** → **Generate** → i-tick ang "I understand" → **Copy**.
2. Sa terminal mo, i-add bilang bagong secret version (ipe-paste mo ang token,
   tapos **Ctrl+Z at Enter** para tapusin ang stdin):

```powershell
gcloud secrets versions add messenger-page-token --data-file=- --project lalamove-map
```

3. Sabihan si Claude na tapos ka — siya ang magpapatakbo ng Cloud Run service
   update para kunin ang bagong `:latest` version (bagong revision).
4. Ulitin ang echo test (§5).

## 5. Ang echo gate test mismo

1. Buksan ang Messenger **bilang sarili mong personal account** (hindi
   "acting as page"). Direktang link sa thread: `https://m.me/105284684761365`
2. Mag-type ng normal text message, hal. `hello test`.
3. **Expected:** eksaktong `Echo: hello test` ang balik, **isang beses lang**.
4. Kung walang balik → basahin ang logs (§2) at itala kung anong linya ang huli.

Paalala (Development mode): tanging accounts na may app role (Administrator /
Developer / Tester sa App Roles page) ang pwedeng maka-receive ng bot replies.

## 6. Kung "Unable to send" sa Messenger client

Ang message ay hindi umalis sa Messenger — walang mararating sa server natin
(walang POST sa logs). Mga dahilan:

- Naka-"acting as Page" ka (nagme-message ang page sa sarili niya) — lumipat sa
  personal profile.
- Restriction sa kaka-delete ng thread — gamitin ang `https://m.me/105284684761365`
  para magbukas ng fresh thread, o subukan sa ibang device/app (hal. phone).

## 7. Thread routing checklist (kapag `standby=1` sa logs)

- Page settings → **Messaging** → "Send conversation to" = **FlowerCart Messenger**
  (hindi Inbox / Manychat) — parehong Messages at Facebook Page routing.
- Business Suite Inbox: markahan ang thread na **Done** (nagre-release ito ng
  thread control) — ang routing change ay HINDI gumagalaw ng existing threads.
- I-disconnect/i-off ang Manychat at anumang Inbox automation (instant reply,
  away message) — sila ang pinagmulan ng mga extra reply tulad ng "close po".
- I-off ang Meta built-in Business AI sa page.
