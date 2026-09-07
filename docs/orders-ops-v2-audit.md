# Orders Operations: Pre-migration UI Audit

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).
> Companion to [orders-ops-v2-ux.md](./orders-ops-v2-ux.md) (Phase A baseline).
> Decisions and rationale derived from this audit live in [decisions.md](./decisions.md)
> (ADR-9, ADR-11, ADR-17); this file documents only the code mechanisms found.

Purpose: use the current `/app/orders` implementation as a baseline but **do not
assume its behavior is correct**. Reproduce the reported smoke-test issues and find
the root cause in source, and catch additional UI bugs / inconsistencies / dead code /
maintainability problems.

Each finding notes whether the mechanism is **confirmed** (verified directly in
source) or **repro-needed** (the most likely mechanism given the code, not yet
isolated from an alternative by a live test).

---

## A. Reported smoke-test issues: root causes

### The mixed modal open/close mechanisms behind S1, S2, S6

Modals opened three different ways and closed a fourth, and the close mechanism
was incompatible with two of the three open mechanisms:

- **Open (most modals):** declarative Polaris command API on a trigger button,
  `commandFor="modal-…" command="--show"` (app.orders.tsx:1337–1364).
- **Open (Archive/Unarchive):** imperative `handleArchive`→`showModal("modal-archive-orders")`,
  which calls `el.show()` or falls back to `el.setAttribute("open","")` (useBulkActions.ts:52–59, 75–76).
- **Open (SharedTagsModal):** a third pattern, `ref` + `el.show()` on a counter
  effect (SharedTagsModal.tsx:23–29).
- **Close on success (all):** `hideModal()` calls `el.hide()` or falls back to
  `el.removeAttribute("open")` (useBulkActions.ts:43–50, 148–153).

The Polaris `s-modal` visibility runs on the command API (`--show`/`--hide`), not
the `open` DOM attribute. `removeAttribute("open")` is a no-op against a modal
shown via a command, and `.hide()` works only when the element exposes that
imperative method. A modal opened via `commandFor="--show"` therefore stayed open
after `hideModal()` ran on a successful action. The one close path that did work
was the in-modal `commandFor="…" command="--hide"` button present in every modal,
but that fires only on a manual click, not on action success.

| # | Symptom | Root cause |
| --- | --- | --- |
| S1 | Archive bulk action appeared to do nothing | The archive modal itself renders correctly (`ArchiveModal.tsx:18`, real `id="modal-archive-orders"`, confirm → `submitBulk("archive")` → `ORDER_CLOSE_MUTATION`): the write path is wired. The break is the imperative `showModal()` open path (useBulkActions.ts:75). If the `s-modal` doesn't expose `.show()`, the `setAttribute("open")` fallback does not open a command-driven modal, so the confirm dialog never appears. |
| S2 | Cancel modal didn't auto-close | Mixed open/close mechanism above: Cancel opens via `commandFor="--show"`; success called `hideModal("modal-cancel-orders")` → `removeAttribute("open")`, a no-op against a command-shown modal. |
| S3 | Fulfillment badge didn't refresh | React Router's default behavior revalidates all active loaders after a `fetcher.submit` action completes (no `shouldRevalidate` export exists anywhere in `app/` to opt out), so the loader itself was not stale. The mechanism is Shopify eventual consistency: `fulfillmentCreate` runs as an async job, so a post-action re-query fired right after the response can still return a stale `displayFulfillmentStatus`. |
| S4 | Remove-tag field had no autocomplete | `RemoveTagsModal` rendered a plain `s-text-field` (comma-separated free text) with no datalist or suggestion source drawn from the selected orders' existing tags. |
| S5 | Bulk actions showed no success/error confirmation | The toast effect (useBulkActions.ts:131–184) fires on a well-formed `fetcher.data`; it shows nothing only when `fetcher.data` is undefined (the action threw before responding) or the response is malformed. Separately, when a modal doesn't close (S2/S6), the toast lands on top of the still-open modal, and the merchant reads that as "no confirmation." |
| S6 | Modals stayed open after a successful action | Same mixed open/close mechanism as S2, applying to every modal closed via `hideModal()` on success. |
| S7 | Bulk mark-fulfilled failed for orders the merchant considered valid | Two candidate mechanisms in `markFulfilled` (app.orders.tsx:704–865). One: atomic batch failure. If the batch fulfillment-order query hits a scope/permission error, `batchQueryFailed=true` skips fulfillment creation for the entire batch, including valid orders (all-or-nothing, :778–799, :802). Two: the `CREATE_FULFILLMENT` filter (:790–795). An order whose fulfillment orders don't list that supported action yields "No fulfillable items remaining." A missing `write_…_fulfillment_orders` scope routes into the first path via `scopeHint`. |
| S8 | Panel "Send email" crashed the embedded app to Chrome's "This content is blocked" page | `OrderDetailsPanel.tsx:122` gave the ActionList item `url: mailto:<customer email>` without `external: true` (its sibling "View order status page" has it, :129). `PolarisAppProvider` (app.jsx:59) sets no `linkComponent`, so Polaris `UnstyledLink` renders a plain `<a>` whose `target` is set only when `external` is true (`@shopify/polaris` UnstyledLink.js:30–37). The click became a same-frame navigation of the app's own iframe to `mailto:`, outside the App Bridge navigation contract (external URLs must use `target="_blank"` or `_top`). Chrome refuses to render the in-iframe `mailto:` navigation, lands the frame on the blocked-content interstitial, and kills the App Bridge handshake (console: `postMessage` target-origin mismatch). Adding `external: true` alone changed the failure mode instead of fixing it; see S9. |

## B. Additional findings

- **B1.** Three different modal-trigger patterns coexisted (`commandFor` vs
  imperative `showModal()` vs ref+counter). Files: app.orders.tsx:1330–1365,
  useBulkActions.ts:43–59, SharedTagsModal.tsx.
- **B2.** Modal visibility was not held in React state. Most modals had no
  `useState` for open/closed; visibility lived in the DOM, so re-opening a
  manually-closed modal, or syncing close-on-success, gave inconsistent results.
- **B3.** `RESCHEDULED_ORDER_TAG` / `resched` is shown to the merchant as a
  "Rescheduled" chip (order-utils `tagDisplayLabel`), and the drawer's timeline gate
  (`showDeliveryTimeline`) also keys off `hasRescheduleTag`: the same tag drives
  both surfaces.
- **B4.** Toast partial-failure formatting truncates order ids by
  `split("/").pop()` and can emit long GraphQL error strings verbatim
  (useBulkActions.ts:164–176).

## C. Dead code / maintainability observations

- **C1.** `getOrderPhone` was imported into `OrderDrawer`, but the drawer surfaced
  phone only via `buildDeliveryInfoText`.
- **C2.** `orders-dashboard.css` hand-rolls a design system (Inter font import,
  `--p-*` token overrides), duplicating what Polaris tokens already provide.
- **C3.** `get-safe-event-value.ts` is a web-component-event-specific helper;
  React synthetic `onChange`/`onInput` events don't need it. Deleted: zero
  importers remained after the Polaris React rewrite.

## D. Correction to an earlier automated pass

An earlier automated pass claimed the Archive modal has no command trigger and
would fail without any error. Verified against source: `ArchiveModal.tsx` renders
a real `s-modal id="modal-archive-orders"`, and its confirm button wires to
`submitBulk("archive")` → `ORDER_CLOSE_MUTATION`. The archive write path is intact;
the defect sits in the imperative *open* mechanism (S1), not a missing trigger.

## E. Additional findings from a second smoke-test pass

- **E1.** Orders metafield search was ignored with no error. The loader's
  `metafields.custom.date` / `metafields.custom.time_slot` query terms were
  dropped by Shopify: metafield search on orders requires a filterable-indexed
  definition, which these two metafields did not have. Live repro: an applied
  time-slot filter returned every order. The fix moved this filtering client-side
  over an enlarged page (250 rows) and removed the server-side query terms.
- **E2.** Polaris `Tabs` was unusable inside the embedded iframe. `IndexFilters`'
  `Tabs` measure their container to decide which tabs fit; in the app iframe the
  measurement raced and collapsed every non-selected tab into the "More views"
  disclosure while earlier paints showed non-interactive label copies, so tab
  clicks did nothing and a selected view (`?tab=unpaid` via the KPI card) had no
  way out. `IndexFilters`' sticky mode (`IntersectionObserver` + fixed band) also
  misfired in the iframe. The fix renders view tabs as a plain Polaris `Button`
  row outside `IndexFilters` (`tabs={[]}`) with `disableStickyMode` set.

---

## F. Bouquet Photo upload (Mark Fulfilled): separate feature audit

A real, wired upload pipeline (client-validated file → staged upload → Shopify
Files → CDN URL in the `custom.bouquet_photo` order metafield) had four defects:

- **F1.** No success/failure feedback to the merchant.
- **F2.** A `fileCreate` async-processing race: the metafield write could run
  before Shopify finished processing the uploaded file.
- **F3.** Metafield writes happened even on failed fulfillments, and a bulk
  mark-fulfilled with one attached photo stamped that same photo onto every order
  in the batch.
- **F4.** Nothing in the codebase read the stored photo back.
- **F5.** A "View bouquet photo" link added to the Shipping confirmation email
  template failed live: Shopify notification-template Liquid resolves order
  metafields to raw values in that context, so the link's `.value` access
  resolved to nil and the link never rendered.

This pipeline no longer exists in the codebase; see
[decisions.md ADR-17](./decisions.md#adr-17-bouquet-photo-upload-mark-fulfilled-removed-from-scope)
for what was removed and why. Residual, harmless dev-store state: test uploads
remain under Admin → Content → Files, and some test orders (e.g. #1009) keep a
stale `custom.bouquet_photo` metafield that nothing reads.

---

## G. Findings from a full smoke-test pass: S9–S13

| # | Symptom | Root cause |
|---|---------|-----------|
| S9 | "Send email" opened a blank "Untitled" tab; no compose window appeared | Two stacked mechanisms. One: `mailto:` + `target="_blank"` opens the new tab as `about:blank` in Chrome, and the external-protocol launch from that fresh tab does not fire consistently. Two: Polaris `ActionList` ignores the item's `target` prop (verified in `Item.js`: only `external` is forwarded to `UnstyledLink`), so a declarative `_top` navigation has no way to be expressed. A synthetic `<a href="mailto:…" target="_top">` built inside the click handler avoided the crash and the orphan tab but produced nothing visible on a machine where the OS `mailto` association (`HKCU …\UrlAssociations\mailto\UserChoice`) resolves to `ChromeHTML`, and Chrome itself has no registered webmail handler for `mailto` (`protocol_handler` prefs have no mailto entry, `custom_handlers: null`). The OS hands mailto to Chrome, Chrome has nowhere to hand it back to, and the handoff drops with no error. The Send email item now links to a Gmail compose URL (`https://mail.google.com/mail/?view=cm&fs=1&to=<email>&su=Order <name>`) with `external: true`, the same `_blank` path "View order status page" uses. |
| S10 | Archived orders still listed in "All" | The loader sent no `status:` term, and the Admin GraphQL `orders` query defaults to ALL orders (open + closed). Probed live: no term → 5 orders incl. both archived; `status:open` → 2 (also drops the cancelled order); `-status:closed` → 3 (open + cancelled, no archived). The loader now appends `-status:closed` for all/today/tomorrow/thisWeek, `status:open` for the unfulfilled/unpaid workqueues, and a dedicated Archived tab uses `status:closed`. |
| S11 | A cancelled order still showed "Unfulfilled" in the list and panel | A cancelled order's `displayFulfillmentStatus` legitimately stays `UNFULFILLED`: every fulfillment badge rendered the raw status and nothing consulted the already-fetched `cancelledAt`. `order-utils` now exposes `isCancelled()`, `fulfillmentBadge()` (Cancelled/critical override), and `isOpenDeliverableOrder()` (excludes cancelled orders from Today/Overdue chips); `getDeliveryStatus()` returns Cancelled first. Wired into the IndexTable row, panel header, and DeliverySection; the unfulfilled tab count and KPI exclude cancelled orders. Display-only: no write-path gating was added. |
| S12 | "This week" always showed zero upcoming deliveries | The week window was Monday-start: on Sunday Jul 12 the window was Mon Jul 6 – Sun Jul 12, excluding every upcoming delivery. `dateRefs` now computes a Sunday→Saturday calendar week, feeding both the tab filter and the tab count. |
| S13 | Clearing the search box left the list filtered until navigating away | `IndexFilters` invokes only `cancelAction.onAction` on Cancel (it never calls `onQueryClear`), and this was wired to a no-op, leaving the committed `?search=` applied with the search box hidden. `cancelAction={{ onAction: onQueryClear }}` now reuses the route's existing `handleQueryClear`, which resets the draft and deletes the URL param in the same call. |
