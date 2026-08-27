# WhatsApp Platform — isolated module

Ang folder na ito ang IISANG tahanan ng lahat ng WhatsApp-channel code.
Layunin: naka-isolate at madaling makita ng merchant ang buong WhatsApp
work sa isang lugar, hindi nakakalat sa `app/services/`.

**Status: scaffolding pa lang — walang code, walang route, walang deploy.**
Walang ADR pa; bago magsimula ang Phase 1, kailangan ng design doc sa
`docs/proposals/` + ADR entry (parehong proseso ng Messenger at ADR-22).

## Isolation contract

- Lahat ng WhatsApp logic (send service, webhook verification, message
  formatting, types, channel adapter) ay dito nakatira — hindi sa
  `app/services/`.
- Ang TANGING lalabas sa folder na ito ay thin route files sa
  `app/routes/` (hal. `webhooks.whatsapp.ts`) na nag-i-import pabalik
  dito — kapareho ng thin-receiver pattern ng `webhooks.messenger.ts`
  at ADR-22.
- Ang FlowerBot brain (agent loop, tools, coverage/fee engine, order
  lookup) ay HINDI dinodoble dito — ini-import mula sa existing shared
  services. Ang WhatsApp ay channel lang, hindi bagong bot. Isa lang ang
  fee computation (see CLAUDE.md "SI JHAY ANG MAY-ARI" section).

## Planned structure (papunan habang umuusad)

```
app/whatsapp/
  README.md                  ← ito
  send.server.ts             ← WhatsApp Cloud API send (text/template/media)
  verify-webhook.server.ts   ← Meta signature verification (X-Hub-Signature-256)
  agent-adapter.server.ts    ← tulay papunta sa shared FlowerBot agent loop
  types.ts                   ← WhatsApp payload types
```

## References

- Meta app: parehong app ng Messenger (App ID 1065300189364788) — ang
  WhatsApp ay idadagdag bilang product sa app na iyon, hindi bagong app.
- Messenger channel implementation (ang pattern na susundan):
  `app/routes/webhooks.messenger.ts` + `app/services/messenger-*.server.ts`.
- Conversation storage pattern: Prisma `MessengerThread`/`MessengerMessage`
  (conversation lang, hindi kailanman ang order — delivery state ay nasa
  Shopify order, see `docs/architecture.md`).
