# delivery-sidekick-data — Sidekick App Data extension

Gives Sidekick three **read-only** tools for answering delivery-scheduling
questions in the Shopify admin. Target: `admin.app.tools.data` (headless — no
UI is rendered).

Upstream docs: [Build app data for Sidekick](https://shopify.dev/docs/apps/build/sidekick/build-app-data).

## Tools

| Tool | Backend route | Cost |
| --- | --- | --- |
| `get_delivery_booked_counts` | `POST /sidekick/tools/booked-counts` | Live Admin order scan (60s memo) |
| `get_order_delivery` | `POST /sidekick/tools/order-delivery` | One Admin GraphQL order query |
| `get_schedule_config_summary` | `POST /sidekick/tools/schedule-config` | Postgres config read only |

All three routes are **read-only** — no Shopify mutations, no delivery-state
writes. They sit outside the `docs/api.md` §2 order write-path contract and
follow the ADR-11 response contract (`200 + {ok:true|false}` even on upstream
failure). See `docs/api.md` → "Sidekick tool routes" and `docs/decisions.md`
ADR-18.

## How it works

1. `src/index.js` registers the three tools with `shopify.tools.register()`.
2. Each handler POSTs JSON to a **relative** URL. The Sidekick sandbox resolves
   it against the app's configured auth domain and attaches the `Authorization`
   session-token header itself — do not hard-code the app origin, and do not
   call `auth.idToken()` here.
3. The route exchanges that token via `authenticate.admin(request)` and answers
   with `cors(...)` because the sandbox is a cross-origin caller.

## Limits worth remembering

- Every tool response must be **≤ 4,000 tokens** and should return within ~1s.
  The backend caps every list (14 dates, 12 slots/date, 10-item samples) and
  reports what it dropped (`datesOmitted`, `slotsOmitted`) instead of dumping.
- Max 20 tools per app, shared across all extensions (3 used here).
- Tool `name` ≤ 64 chars, `description` ≤ 512 chars, `instructions.md`
  ≤ 2,048 tokens, extension `description` ≤ 256 tokens.

## Files

- `src/index.js` — tool registration + the shared relative-fetch wrapper
- `tools.json` — input/output schemas (kept honest to what the routes return)
- `instructions.md` — when Sidekick should reach for which tool
- `locales/` — merchant-facing name/description (drives Sidekick relevance)

## Testing

`shopify app dev` and open the `admin.app.tools.data` preview link in the Dev
Console. There are no `@shopify/ui-extensions-tester` tests for this target —
the tester only supports render targets.
