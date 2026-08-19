# delivery-sidekick-actions — Sidekick App Actions extension

Two deep links that let Sidekick take the merchant to the page in this app
where a delivery change is made. Type `admin_link`, target
`admin.app.intent.link`.

Upstream docs: [Build app actions for Sidekick](https://shopify.dev/docs/apps/build/sidekick/build-app-actions).

## Intents

| Intent | `type` / `action` | Destination | Schema |
| --- | --- | --- | --- |
| Reschedule an order's delivery | `application/shipment` / `edit` | `/app/orders?order=<legacyId>&search=<#name>` | `intent-order-reschedule.json` |
| Open the scheduler on a date | `application/shipment` / `create` | `/app/scheduler?date=<YYYY-MM-DD>` | `intent-scheduler-date.json` |

### Why `application/shipment`

Intent `type` is a **fixed Shopify enum** — declaring anything else makes
`shopify app deploy` reject the extension with
`Intent is invalid: type '<value>' is not supported`. The `shopify/order` type
exists but only supports `import` / `import+bulk`, which is the wrong verb for
"change when this order is delivered". `application/shipment` (create/edit) is
the closest supported fit for a scheduled delivery. Recorded in
`docs/decisions.md` ADR-18.

Both intents map their value with `mapTo: "query_param"` — the destination URLs
carry query params, not `{placeholder}` path segments, so `param` would be
wrong. `?order=` and `?date=` are pre-existing URL state in
`app/routes/app.orders.tsx` and `app/routes/app.scheduler.tsx`; the only app
change made for this extension was normalising a GID passed to `?order=` down
to its numeric tail.

## In-page tools — DEFERRED

Sidekick only registers intents that declare at least one tool
("If `tools` isn't set … or your `tools.json` is empty, then your intent won't
be registered with Sidekick"), and for an `admin_link` extension the handler is
registered by the React component at the destination URL — not by this
extension. `tools.json` therefore declares one optional, read-only
`describe_open_delivery_view` tool.

**The tool's own `description` is what steers Sidekick away from calling it** —
it states outright that the tool is an optional confirmation step and that the
merchant is already on the right page once the action has run. `instructions.md`
sets the surrounding policy (navigation is the action; never claim a delivery
was changed), but the per-tool description is the field Sidekick actually reads
when deciding whether a tool is relevant.

**The handler is not registered in App Home yet.** Deep-link navigation works
regardless; if Sidekick ever calls the tool, that call will not resolve. Wiring
`shopify.tools.register()` into `/app/orders` and `/app/scheduler` is a
follow-up — tracked in [docs/known-issues.md](../../docs/known-issues.md).

## Limits

- Max 5 intents per app (2 used).
- Max 20 tools per app, shared with `delivery-sidekick-data` (3 + 1 = 4 used).
- Intent `inputSchema` must `$ref` the schema matching its `type` and must not
  declare `required` anywhere.
- `instructions.md` ≤ 2,048 tokens; `description` ≤ 256 tokens.

## Testing

`shopify app dev` may not upload intent schemas correctly — use
`npm run deploy:dev` and exercise it from Sidekick in the admin.
