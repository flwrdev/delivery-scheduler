# Support chat (customer account)

Full-page customer-account UI extension (`customer-account.page.render`) that
renders the FlowerCart AI support chat, backed by the same agent brain the
Messenger bot runs (`app/routes/api.support-chat.tsx` +
`api.support-chat_.$jobId.tsx`).

Because this is a **full-page** target, Shopify requires it to be the only
target in its extension — that's why it lives in its own
`extensions/support-chat/` directory instead of next to
`delivery-date-editor` or `delivery-reschedule-customer`.

## One-time setup (Partner Dashboard)

Before this extension can call the backend, network access has to be turned
on for the app: **Partner Dashboard → your app → Configuration → "Allow
network access in checkout and account UI extensions"**. Without this toggle
every `fetch()` call from the extension is blocked and the chat will just show
the timeout/error banner.

## After deploy — add the page in the editor

Deploying the extension does not place it anywhere by itself. In the Shopify
admin, go to **Settings → Checkout and accounts → Customize** (the checkout
and accounts editor), open the customer-account section, and add the
"Support chat" page block from the extension picker so it appears as a page
customers can navigate to.

## Dev preview

```bash
npm run dev
```

then press `p` to open the dev preview picker and select the Support chat
extension. The preview runs against the DEV app (`shopify.app.toml`) per
ADR-14 — never run a bare `shopify app deploy`.

## Notes

- Preact + hooks only, no other runtime deps, to stay well inside the 64 KB
  compiled bundle cap.
- A fresh `shopify.sessionToken.get()` call is made immediately before every
  fetch (start POST and every poll GET) — tokens live 5 minutes and are never
  cached or reused across requests.
- The composer (text field + send button) is pinned above the chat thread.
  `s-scroll-box` does not emit scroll events and this sandbox has no DOM
  access, so the extension cannot auto-scroll to the newest message — see the
  comment in `src/SupportChat.jsx` for the full reasoning.
