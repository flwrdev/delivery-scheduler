# Theme: Migrate Featured Collection "Show more" to Direct Storefront API (Option B)

> **⚠️ CROSS-REPO PLAN — DOES NOT APPLY TO THIS REPO.** This plan's execution target is `D:\Download\LPC Issue\live-theme-clean` (a separate Shopify theme repo), **not** `delivery-scheduler`. It's saved here only as a reference record of the decision and prepared prompt, because the backend work that motivated it (see [`../decision-log.md`](../decision-log.md), 2026-07-02 entry) happened in this repo. If you're executing this plan, `cd` to the theme repo first — none of the files below exist in `delivery-scheduler`.

> **For agentic workers:** this is a hand-off prompt, not a checkbox task list — paste the "Implementation prompt" section below into a fresh session opened in the theme repo. It's self-contained (assumes no memory of the `delivery-scheduler` conversation that produced it).

**Goal:** Eliminate the Cloud Run/App Proxy hop entirely for the homepage Featured Collection's "Show more" button by having the theme call Shopify's Storefront GraphQL API directly from the browser, instead of going through `delivery-scheduler`'s `/apps/schedule-rules/products` route.

**Why this is a separate task from the 2026-07-02 backend fix:** that fix (logged in `../decision-log.md`) removed the Neon/Prisma session-storage dependency from the backend route, but a plain Cloud Run container cold start can still occur on the first hit of the day. Cutting the backend out of the loop entirely (this plan) is the only way to remove cold start from this feature completely.

**Architecture:** Client-side only — no backend changes, no new routes, no new repos touched other than the theme. A new public Storefront Access Token (manual setup, not automatable) plus ~1 new theme setting, ~2 new `data-*` attributes, and a rewritten `fetch` call inside one existing JS class.

**Tech Stack:** Shopify Dawn theme (Liquid + vanilla JS, no build tooling) calling the Shopify Storefront GraphQL API directly.

---

## Files (in the theme repo, `live-theme-clean`)

| File | Change |
|---|---|
| `config/settings_schema.json` | Add one new `text` setting for the public Storefront Access Token |
| `sections/featured-collection.liquid` | Add `data-storefront-token` / `data-shop-domain` attributes to the existing `<collection-show-more>` element |
| `assets/global.js` | Rewrite `CollectionShowMore.loadMore()` to call the Storefront API directly instead of `/apps/schedule-rules/products`; `buildShowMoreCard()` should need no changes |
| `docs/decision-log.md` (theme repo) | Add an entry recording this migration, per that repo's own convention |
| `docs/architecture.md` (theme repo) | Update if it currently documents the old dependency |

---

## Implementation prompt (paste this into a fresh session in `live-theme-clean`)

### Context / why this exists

The homepage Featured Collection has a "Show more" button that AJAX-loads additional products beyond the initial server-rendered batch. Today it fetches JSON from `/apps/schedule-rules/products`, a Shopify App Proxy route forwarded to a separate backend (`delivery-scheduler`, a Cloud Run app in a different repo). That backend has `--min-instances 0` (Cloud Run cold start) — a prior fix already removed its Postgres/Neon dependency (it now calls the Storefront API itself, server-side), but the Cloud Run container cold start on the first hit of the day still remains. This task eliminates that hop entirely: the theme will call Shopify's Storefront GraphQL API **directly from the browser**, with no backend involved at all for this feature.

A sibling migration already happened for the *other* "Load more" button (main collection page, `sections/main-collection-product-grid.liquid`) — it moved to native Shopify section rendering. That approach was deliberately **not** used for the Featured Collection button because that section has no `{% paginate %}` foundation (it uses a hardcoded `for ... limit:` loop) and has bestseller-badge CSS tied to `forloop.index` — reworking that to native pagination risked badge/cap regressions. See `docs/decision-log.md` (theme repo), 2026-07-02 entry, for the full reasoning — **read it first**, it's exactly this task's back-story and was written by the session that scoped this exact work.

### Repo & environment

- Working directory: `D:\Download\LPC Issue\live-theme-clean` — a Shopify Dawn theme (base 15.5.0) for flowercart.store, store `hsrwva-nr.myshopify.com`. Pure Liquid + vanilla JS/CSS, no build tooling, no package.json.
- Read `CLAUDE.md` first (short, links out to `docs/decision-tree.md`, `docs/coding-standards.md`, etc. — load only what the task needs per its own table).
- **Verify the live theme ID every session** with `npx shopify theme list --json` — roles rotate; do not trust any ID mentioned anywhere in this prompt or in stale docs without re-checking.
- Working agreement: no git commits unless explicitly asked (local-file edits + `npx shopify theme push`); don't push to the live theme without explicit go-ahead.
- The `delivery-scheduler` backend repo is **not present here** and is out of scope — don't try to edit it.

### Current implementation — verified by reading the code (re-confirm before changing anything; theme files change over time)

- `sections/featured-collection.liquid` (~lines 301–322): renders a `<collection-show-more>` custom element with `data-grid-id`, `data-collection` (handle), `data-per-page`, `data-max`, `data-total`.
- `assets/global.js` (~lines 1542–1637): `CollectionShowMore` custom-element class. `loadMore()` currently does:
  ```
  GET /apps/schedule-rules/products?collection=<handle>&cursor=<cursor>&offset=<offset>&limit=<limit>
  ```
  expecting JSON `{ products: [...], nextCursor, hasNextPage }`.
- `assets/global.js` (~lines 1643–1722): `window.buildShowMoreCard(product)` builds card HTML client-side. Reads: `product.title`, `product.handle`, `product.availableForSale`, `product.priceRange.minVariantPrice.{amount,currencyCode}`, `product.compareAtPriceRange.minVariantPrice.{amount,currencyCode}`, `product.featuredImage.{url,altText,width,height}`. **Its header comment claims it's shared with the collection-page "Load more" — that's stale**: confirmed via grep that `collection-load-more.js` (the already-migrated sibling) no longer calls it at all; `buildShowMoreCard` is now only used by `CollectionShowMore`. Feel free to fix that one comment while you're in there — optional, not required for this migration.
- Pagination bookkeeping lives entirely in the custom element: `perPage`, `max` (cap), `total`, `offset` (first request only — count of `.grid__item`s Liquid already rendered, since GraphQL cursors have no numeric offset), `nextCursor` (from the previous response), stop conditions (`hasNextPage` false, zero products returned, or `loadedCount >= cap`).
- No Storefront Access Token of any kind currently exists anywhere in this theme (`settings_schema.json`, `settings_data.json`, `.env`, JS) — confirmed via grep. This is a genuinely new capability, not a rewiring of an existing one.
- No `Shopify.shop`/`window.Shopify` global with the shop domain is currently exposed in `layout/theme.liquid` — you'll need to inject the shop domain via a Liquid data attribute, same pattern as the other `data-*` attributes already on this element.

### Objective

Replace the `fetch('/apps/schedule-rules/products?...')` call inside `CollectionShowMore.loadMore()` with a **direct browser-side call to Shopify's Storefront GraphQL API**. Everything else — button, card markup, cap/offset/cursor bookkeeping, the shape `buildShowMoreCard` expects — must behave identically to today. This is a data-source swap, not a UX or markup change. Minimize changes; don't refactor anything not directly load-bearing for this swap.

### Explicit non-goals / out of scope

- Don't touch `sections/main-collection-product-grid.liquid` or `assets/collection-load-more.js` — unrelated, already migrated.
- Don't modify the `delivery-scheduler` Cloud Run repo. Its `/apps/schedule-rules/products` route becomes unused by the theme after this ships — note that as a follow-up for whoever owns that repo, but don't delete anything there.
- Don't refactor `featured-collection.liquid`'s initial server-rendered batch, its bestseller-badge CSS, or its `for ... limit:` loop.
- Don't change visual design, card markup, or CSS.

### Implementation strategy

**1. GraphQL query — use the modern, non-deprecated Storefront pattern, not a copy of the backend's query.**

The Cloud Run backend's existing query uses `collections(first: 1, query: "handle:...")` — an Admin-API-style filter search. On the Storefront API, `collectionByHandle` and `collections(query:)` are legacy/deprecated for this purpose. Use the direct `QueryRoot.collection(handle:)` field instead:

```graphql
query CollectionProducts($handle: String!, $first: Int!, $after: String) {
  collection(handle: $handle) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          handle
          availableForSale
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          compareAtPriceRange {
            minVariantPrice {
              amount
              currencyCode
            }
          }
          featuredImage {
            url
            altText
            width
            height
          }
        }
      }
    }
  }
}
```

This was validated against the Storefront 2026-04 schema via Shopify's `validate_graphql_codeblocks` MCP tool — schemas evolve, so re-validate against the current version before finalizing, don't trust this snippet blindly. Response path is `data.collection.products`, **not** `data.collections.nodes[0].products` like the old backend — update parsing accordingly. Field names already match what `buildShowMoreCard` expects (that function's shape was deliberately modeled after the Storefront API originally) — don't change that function unless a genuine mismatch turns up; if one does, reshape the fetch response rather than the function.

**2. Get a public Storefront Access Token — manual step, cannot be automated.**

Must be a **public** token (browser-safe), not the private one already configured in the `delivery-scheduler` Cloud Run repo's `SHOPIFY_STOREFRONT_ACCESS_TOKEN` secret — different token type, out of scope of this repo, do not reuse or reference it. Create via Shopify Admin → Settings → Apps → Develop apps → [app] → API credentials → Storefront API access token, or via the Headless sales channel. **Ask the user for this / flag it clearly rather than assuming it exists** — confirmed during scoping that nothing like it currently exists in this theme. Public tokens are explicitly designed to be embedded client-side (that's the documented "public access" model) — it is not a secret in the same sense as an API key; don't treat it defensively.

**3. Where to put the token + shop domain.**

- Add a setting to `config/settings_schema.json` (plain `text` input — there's no masked/secret field type, and this token is meant to be public) so it's editable from the theme editor without a redeploy. Check the existing schema structure/grouping before deciding where it goes — don't invent a new top-level section if an existing "Advanced"/custom group fits.
- Inject via new `data-*` attributes on `<collection-show-more>` in `featured-collection.liquid`, e.g. `data-storefront-token="{{ settings.storefront_access_token }}"` and `data-shop-domain="{{ shop.permanent_domain }}"` — same pattern already used for `data-collection`, `data-per-page`, etc.
- Confirm `shop.permanent_domain` (the `.myshopify.com` domain, not the custom `flowercart.store` domain) is the right host for Storefront GraphQL requests — this is the standard approach, but verify against current docs rather than assuming.

**4. Rewrite `CollectionShowMore.loadMore()` in `assets/global.js`.**

- Replace the App Proxy GET with a `fetch` POST to `https://${shopDomain}/api/${version}/graphql.json`, headers `Content-Type: application/json` and `X-Shopify-Storefront-Access-Token: <token>` (note: this is the **public**-token header, different from the `Shopify-Storefront-Private-Token` a server would send). Body: `{ query, variables: { handle, first, after } }`.
- **Preserve the offset-alignment behavior exactly** — this is the single highest-risk detail. On the very first `loadMore()` call (no `nextCursor` yet), the old backend over-fetched `offset + limit` items then sliced off the first `offset` (already server-rendered by Liquid) before returning. That logic must move into this theme JS unchanged in effect:
  - `first: (no cursor yet) ? offset + limit : limit`
  - After the response, if there was no cursor, `edges = edges.slice(offset)` before taking the first `limit` to render.
  - Get this wrong and the first click will duplicate or skip products. Test this explicitly (see Verification).
- Preserve: `hasNextPage` computation, `nextCursor` tracking, cap/`toggleButton()` logic, loading-spinner toggling, and the `catch` path (console.error, leave button visible/re-enabled so the customer can retry — don't silently hide it on network failure).

**5. CORS.** Storefront API with a public token is designed for direct browser calls and supports CORS for this out of the box — confirm this holds during manual testing rather than assuming. A CORS error is a stop-and-report situation, not something to route around with a proxy (that would defeat the migration's purpose).

### Verification steps (in order)

1. `npx shopify theme check` — must stay clean (there's a documented OOM workaround in `docs/development.md` if needed).
2. `npx shopify theme dev` local preview: click "Show more" repeatedly until the button disappears. Confirm no duplicate products, no skipped products (cross-check against a direct collection browse), correct stop point matching the cap, sold-out badges still correct, no console/CORS errors, no failed requests. Confirm first-click latency is now fast — that's the actual point of this migration.
3. Push to an **unpublished** preview theme first (`playbooks/theme-release.md` step 4) before touching live.
4. Only push to LIVE if the user explicitly says so — re-verify the live theme ID first, back up current live per the playbook (`theme pull` to a fresh `../live-backup-<date>`, deleting older backups first), then follow `playbooks/theme-release.md` in full.
5. Record the change in `docs/decision-log.md` (theme repo — this is exactly the kind of migration the playbook says warrants an entry) and update `docs/architecture.md` (theme repo) if it currently documents the old dependency for this section.

### Rollback plan

- Standard theme rollback: re-push the pre-change backup folder (`../live-backup-<date>`) to the live theme ID if something breaks post-push.
- No build step, no data migrations, nothing else depends on the new theme setting existing — rollback is just re-pushing prior file versions.
- Faster partial rollback if the issue is isolated to this feature: revert just `CollectionShowMore` and the new `data-*` attributes back to calling `/apps/schedule-rules/products` — that endpoint stays live and functional in the backend (this task doesn't remove it), so it's a safe fallback target even after this ships.

### Success criteria

- Featured Collection "Show more" behaves identically to today from the customer's side: same products, same order, same cap, same badges/pricing, same error handling.
- No network requests to `/apps/schedule-rules/products` or the `delivery-scheduler` Cloud Run domain when using this feature.
- First "Show more" click is fast — verified by manual timing, not just "seems fine."
- `theme check` clean; no console/CORS errors in manual testing.
- `main-collection-product-grid.liquid`, `collection-load-more.js`, and the `delivery-scheduler` repo untouched.
- Change documented in `docs/decision-log.md` (theme repo) and `docs/architecture.md` (theme repo) if applicable.
- Nothing pushed to the live theme without explicit go-ahead.

### Open questions — resolve with the user, don't guess silently

- Confirm the public Storefront Access Token exists or needs creating (manual dashboard step) — none exists in this theme today.
- Confirm which Storefront API version to target.
- Confirm the user is comfortable with the token being visible in the theme editor to anyone with theme-edit access (expected for a public token, but worth an explicit nod given it's new).
