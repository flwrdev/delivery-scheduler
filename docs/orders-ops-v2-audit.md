# Orders Operations — Pre-migration UI Audit

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).
> Companion to [orders-ops-v2-ux.md](./orders-ops-v2-ux.md) (Phase A baseline).
> **Status: Phase 2 findings CLOSED (live-verified 2026-07-11).** Findings +
> root cause first; **no business-logic change until a finding is explicitly
> approved.**
>
> **Phase 2 shipped 2026-07-11 and live-verified the same day** (merchant
> smoke test round 1 + round-2 fixes + full re-test PASSED on the dev app):
> the mixed modal open/close mechanism behind **S1/S2/S5/S6 + B1/B2** is gone —
> all modals are Polaris React `Modal`s whose visibility is React state
> (`activeModal` in `useBulkActions`), closed on fetcher success by a plain
> setState — **confirmed live: every bulk action auto-closes its modal and
> shows a toast → S1/S2/S5/S6 + B1/B2 CLOSED.** **S4 CLOSED** (Remove-tags
> clickable suggestions confirmed working live). **C3** resolved:
> `get-safe-event-value.ts` deleted (zero importers after the React rewrite).
> **E1/E2 CLOSED** (round-2 fixes re-tested live — see §E). **S3 CLOSED**
> (Phase 3 delayed re-poll live-verified 2026-07-11 — the mark-fulfilled badge
> settles within ~3s). Still open: **S7** (bulk mark-fulfilled) remains
> repro-needed. New (Phase 3 smoke test, pre-existing): the panel timeline's
> "Original schedule" row duplicates Current after any reschedule — the
> reschedule write path overwrites the `customAttributes` it derives from
> (legacy mirror). **FIXED with Phase 4 (2026-07-11) — live re-check PASSED
> 2026-07-12** (Original row correct after single + bulk merchant
> reschedules). **New (Phase 5 round-1 smoke test, 2026-07-12): S8** —
> the panel's "Send email" action same-frame-navigates the embedded iframe to
> `mailto:` (no `external`/`target="_blank"`), crashing the app to Chrome's
> "This content is blocked" page; root cause confirmed in source. **Fix
> APPROVED + APPLIED 2026-07-12** (`external: true` on the item) — pending
> live re-test via the §8-FST Final Full Smoke Test. **§F Bouquet Photo
> (separate feature audit, 2026-07-12) — REMOVED FROM SCOPE (merchant
> decision, same day):** classified incomplete implementation; a completion
> attempt (conditional email photo link) shipped uncommitted, then FAILED its
> round-1 live email test on notification-template Liquid semantics (F5).
> Rather than depend on Shopify notification templates while uncertainty
> remains, the merchant descoped the feature and the ENTIRE pipeline was
> deleted from the codebase (F1–F5 closed-by-removal; may return later as a
> separate enhancement with clear product requirements). See §F.

Purpose: use the current `/app/orders` implementation as a baseline but **do not
assume its behavior is correct**. Reproduce the reported smoke-test issues, find the
root cause, and catch additional UI bugs / inconsistencies / dead code / maintain-
ability problems before the Polaris React rewrite. Each finding is tagged with how
it should be handled:

- **[rewrite-fixes]** — a presentation bug the Polaris React rewrite resolves as a
  side effect (no separate business-logic change).
- **[logic-bug]** — a real behavior bug in the loader/action/services; needs an
  explicit, separately-approved fix (per the user's instruction).
- **[cleanup]** — dead code / maintainability only.

---

## A. Reported smoke-test issues (root-caused against code, 2026-07-11)

> "Confirmed" = mechanism verified in source. "Repro-needed" = root cause is the
> most likely mechanism but needs one live smoke-test to distinguish from an
> alternative. Line anchors are current `app.orders.tsx` / hook / modal files.

### The common root cause behind S1, S2, S6 — mixed modal open/close mechanisms

The single biggest defect cluster. Modals are **opened** two different ways and
**closed** a third way, and the close way is incompatible with the open way:

- **Open (most modals)** — declarative Polaris command API on a trigger button:
  `commandFor="modal-…" command="--show"` (app.orders.tsx:1337–1364).
- **Open (Archive/Unarchive)** — imperative `handleArchive`→`showModal("modal-archive-orders")`
  which does `el.show()` or `el.setAttribute("open","")` (useBulkActions.ts:52–59, 75–76).
- **Open (SharedTagsModal)** — a third pattern: `ref` + `el.show()` on a counter
  effect (SharedTagsModal.tsx:23–29).
- **Close on success (ALL)** — `hideModal()` does `el.hide()` **or**
  `el.removeAttribute("open")` (useBulkActions.ts:43–50, 148–153).

The Polaris `s-modal` visibility is driven by the **command API** (`--show`/`--hide`),
not by the `open` DOM attribute. So `removeAttribute("open")` is a no-op against a
modal that was shown via a command, and `.hide()` only works if the element exposes
that imperative method. **Net effect: modals opened via `commandFor="--show"` are
not reliably closed by `hideModal()` after a successful action → they stay open
(S2, S6).** The confirmed close path that *does* work is the in-modal
`commandFor="…" command="--hide"` button (present in every modal) — but that only
fires on manual click, not on action success.

| # | Reported symptom | Status | Root cause (verified) | Handling |
| --- | --- | --- | --- | --- |
| S1 | Archive bulk action "not working" | **Repro-needed** | The archive modal **does** render correctly (`ArchiveModal.tsx:18`, real `id="modal-archive-orders"`, confirm → `submitBulk("archive")` → `ORDER_CLOSE_MUTATION`). So the write path is wired. The likely "not working" is the **imperative `showModal()` open path** (useBulkActions.ts:75): if the s-modal doesn't expose `.show()`, the `setAttribute("open")` fallback may not open a command-driven modal — so the confirm dialog never appears and the merchant perceives "archive does nothing." **The agent's claim that the modal has no trigger is WRONG** — it has an `onClick` trigger; the bug is the trigger *mechanism*, not a missing one. **[rewrite-fixes]** | ✅ CLOSED (Phase 2, live-verified 2026-07-11) |
| S2 | Cancel modal doesn't auto-close | **Confirmed** | Mixed open/close mechanism above. Cancel opens via `commandFor="--show"`; success calls `hideModal("modal-cancel-orders")` → `removeAttribute("open")`, a no-op against a command-shown modal. **[rewrite-fixes]** | ✅ CLOSED (Phase 2, live-verified 2026-07-11) |
| S3 | Fulfillment badge doesn't refresh | **Repro-needed** (downgraded from "Confirmed" 2026-07-11, REC-6) | Original root-cause claim **withdrawn**: React Router's default behavior IS to revalidate all active loaders after a `fetcher.submit` action completes, and no `shouldRevalidate` export exists anywhere in `app/` to opt out — so "the route doesn't auto-revalidate" contradicts framework behavior. More likely mechanism: **Shopify eventual consistency** — `fulfillmentCreate` is processed asynchronously, so even an immediate post-action re-query can return a stale `displayFulfillmentStatus`. Fix = §6 immediate revalidate **plus a ~3s delayed re-poll** after fulfillment-type actions (approved). Needs one live repro to confirm the mechanism. **[logic-bug-adjacent]** — presentation/data-sync, no service change. **Delayed re-poll SHIPPED with Phase 3 (2026-07-11, in `useBulkActions`)** — Phase 3 merchant smoke test (2026-07-11) confirmed the badge now settles within ~3s after mark-fulfilled. | ✅ CLOSED (Phase 3, live-verified 2026-07-11) |
| S4 | Remove-tag has no autocomplete | **Confirmed** | `RemoveTagsModal` renders a plain `s-text-field` (comma-separated free text); no datalist / suggestion source of the selected orders' existing tags. It's a **missing feature**, not a regression. **[logic-bug]** (new UI feature — needs explicit approval; adds a client-side tag set from loaded orders, no server change). | ✅ CLOSED (Phase 2 approved add-on, live-verified 2026-07-11) |
| S5 | No success/error confirmation | **Repro-needed** | The toast effect (useBulkActions.ts:131–184) DOES fire on a well-formed `fetcher.data`. It shows nothing only when `fetcher.data` is undefined (action threw before responding) or the response is malformed. Also: **for the Archive/Cancel/etc. modals, if the modal never closes (S2/S6), the toast is emitted but visually competes with the stuck modal**, so the merchant reports "no confirmation." Likely a *perception* of S2/S6 rather than a separate bug. **[rewrite-fixes]** (+ defensive null-check). | ✅ CLOSED (Phase 2, live-verified 2026-07-11 — toasts confirmed on every bulk action) |
| S6 | Modals stay open after success | **Confirmed** | Same mixed open/close root cause as S2 — applies to all modals closed via `hideModal()` on success. **[rewrite-fixes]** | ✅ CLOSED (Phase 2, live-verified 2026-07-11 — modals auto-close on success) |
| S7 | Bulk mark-fulfilled fails for all-valid orders | **Repro-needed** | Two candidate causes in `markFulfilled` (app.orders.tsx:704–865): (a) **atomic batch failure** — if the batch fulfillment-order query hits a scope/permission error, `batchQueryFailed=true` skips *all* fulfillment creation incl. valid orders (all-or-nothing, :778–799, :802); (b) **`CREATE_FULFILLMENT` filter** (:790–795) — an order whose fulfillment orders don't list that supported action yields "No fulfillable items remaining," which reads as a failure for an order the merchant considers valid. Most probable for "all valid orders fail": a **missing `write_…_fulfillment_orders` scope** → `scopeHint` path. Needs one live repro to pick (a) vs (b). **[logic-bug]** if it's the atomicity/scope path. | audit → Phase 2/4 |
| S8 | Panel "Send email" crashes the embedded app — the app area shows Chrome's "This content is blocked. Contact the site owner to fix the issue." (found 2026-07-12, Phase 5 exploratory testing) | **Confirmed** (root cause traced in source + the documented App Bridge contract; NOT yet fixed) | **A V2-introduced regression, not carried over** — the old `OrderDrawer` had no Send email action at all (grep of `HEAD:app/components/OrderDrawer.tsx`: zero `mailto`/email matches); the panel's actions menu added it in Phase 1 and this was the first live click. Execution path: `OrderDetailsPanel.tsx:122` gives the ActionList item `url: mailto:<customer email>` **without `external: true`** (its sibling "View order status page" has it, :129). The `PolarisAppProvider` (app.jsx:59) sets **no `linkComponent`**, so Polaris `UnstyledLink` renders a plain `<a>` whose `target` is only set when `external` is true (verified in `@shopify/polaris` UnstyledLink.js:30–37) → the click is a **same-frame navigation of the app's own iframe to `mailto:`**. That is outside the App Bridge navigation contract — per the official Navigation API doc, in-frame anchors are for app routes / `shopify://admin/…` only, and **external URLs must use `target="_blank"` (new tab) or `_top`**. Chrome refuses to render the in-iframe `mailto:` navigation → the frame lands on the blocked-content interstitial, and the admin↔app App Bridge handshake dies (console: `postMessage` target-origin mismatch, tunnel origin vs `admin.shopify.com`) — app dead until reload. Why the neighbors are safe: "View order status page" = `external: true` (new tab); "Open in Shopify Admin" = `shopify://admin/orders/<id>` (App Bridge-intercepted top-level nav); "Update delivery slot" / "Copy delivery info" / add-tag = no navigation. **Fix (approved by the merchant 2026-07-12, APPLIED same day):** `external: true` added to the Send email item (OrderDetailsPanel.tsx) so the mailto opens outside the iframe, matching the status-page item. **[rewrite-introduced presentation bug]** | **`external: true` fix FAILED its live re-test 2026-07-12** (§8-FST round 1, two runs): no more crash, but Chrome parks the mailto in a blank "Untitled" tab and no compose window ever appears → superseded by **S9 (§G)** — mailto triggered on the TOP frame instead of `_blank`. ✅ CLOSED via S9 |

## B. Additional findings (discovered during audit)

- **B1 — Inconsistent modal-trigger patterns (3 ways).** `commandFor` vs imperative
  `showModal()` vs ref+counter. Fragile; the rewrite unifies to React `open` state.
  Files: app.orders.tsx:1330–1365, useBulkActions.ts:43–59, SharedTagsModal.tsx.
  **[rewrite-fixes]**
- **B2 — Modal visibility not in React state.** Most modals have no `useState` for
  open/closed; visibility lives in the DOM. Re-opening a manually-closed modal, or
  syncing close-on-success, is unreliable. **[rewrite-fixes]**
- **B3 — `RESCHEDULED_ORDER_TAG` / `resched` shown to merchant as "Rescheduled"
  chip** (order-utils `tagDisplayLabel`) but the drawer's timeline gate
  (`showDeliveryTimeline`) also keys off `hasRescheduleTag`. Fine today; just note
  the V2 timeline must not double-count. **[cleanup]**
- **B4 — Toast partial-failure formatting** truncates order ids by `split("/").pop()`
  and can emit very long GraphQL error strings (useBulkActions.ts:164–176). UX
  polish in the rewrite. **[cleanup]**

## C. Dead code / maintainability

- **C1 — `getOrderPhone` imported into OrderDrawer but the drawer surfaces phone via
  `buildDeliveryInfoText` only** — the V2 panel will surface sender phone directly
  (a requested field), so this becomes used, not dead. Recheck at Phase 1.
- **C2 — `orders-dashboard.css`** hand-rolls a design system (Inter font import,
  `--p-*` token overrides). Mostly replaced by Polaris tokens in the rewrite; prune
  at Phase 5.
- **C3 — `get-safe-event-value.ts`** is web-component-event specific; after the React
  rewrite most `onChange`/`onInput` use React synthetic events and this helper's
  callers shrink. Recheck at Phase 2.

## D. Correction to the automated audit

The first automated pass claimed the **Archive modal has no command trigger and
would "fail silently"** — this is **incorrect**. Verified: `ArchiveModal.tsx`
renders a real `s-modal id="modal-archive-orders"` and the confirm button wires to
`submitBulk("archive")` → `ORDER_CLOSE_MUTATION`. The archive **write path is
intact**; any failure is in the imperative *open* mechanism (S1), not a missing
trigger. Root causes in §A supersede the automated pass where they differ.

## E. Round-2 findings (Phase 2 smoke test, 2026-07-11)

- **E1 — Orders metafield search silently ignored.** The loader's
  `metafields.custom.date` / `metafields.custom.time_slot` query terms were
  dropped by Shopify (metafield search on orders requires a
  filterable-indexed definition), so the Today/Tomorrow tabs and both toolbar
  filters **never filtered — in production either**. Confirmed by live repro
  (applied time-slot filter returned every order). **[logic-bug] ✅ CLOSED —
  FIXED 2026-07-11, merchant re-test PASSED same day** (Today/Tomorrow tabs
  and both toolbar filters confirmed narrowing the list correctly): all
  metafield-based filtering is client-side over an enlarged page (250 rows);
  server terms removed. Future option: enable the filterable capability on
  the two definitions and move it back server-side.
- **E2 — Polaris Tabs unusable inside the embedded iframe.** `IndexFilters`'
  Tabs measure their container to decide which tabs fit; in the app iframe the
  measurement raced and collapsed every non-selected tab into the "More views"
  disclosure while earlier paints showed non-interactive label copies — tab
  clicks did nothing, so a selected view (`?tab=unpaid` via the KPI card)
  could never be left (the reported "phantom tab=unpaid", which also broke
  panel-refresh persistence). IndexFilters' sticky mode (IntersectionObserver
  + fixed band) also misfires in the iframe. **[rewrite-fixes] ✅ CLOSED —
  FIXED 2026-07-11, merchant re-test PASSED same day** (all view tabs
  clickable with a real mouse, stuck params clear on tab change, panel
  survives refresh): view tabs are a plain Polaris Button row outside
  IndexFilters (`tabs={[]}`), and `disableStickyMode` is set.

---

## F. Bouquet Photo upload (Mark Fulfilled) — separate feature audit (2026-07-12)

> Merchant-requested standalone audit, tracked SEPARATELY from Phase 5.
> **Overall classification was INCOMPLETE IMPLEMENTATION**: a real, wired
> upload pipeline (client-validated file → staged upload → **Shopify Files**
> → CDN URL in the `custom.bouquet_photo` order metafield; introduced pre-V2
> in `f154c2d`, 2026-06-02) — but with no success/failure feedback (F1), a
> `fileCreate` async-processing race (F2), metafield writes even on failed
> fulfillments + one-photo-stamps-all bulk semantics (F3), and **zero
> consumers of the stored photo** (F4).
>
> **FINAL DISPOSITION — REMOVED FROM SCOPE 2026-07-12 (merchant decision).**
> A completion attempt shipped the same day (conditional "View bouquet photo"
> link in the Shipping confirmation email + F1/F2/F3 fixes, all uncommitted),
> but the round-1 live email test failed on notification-template Liquid
> semantics (**F5**: order metafields resolve to raw values in that context —
> the provided snippet's `.value` was nil, so the link never rendered; the
> app's write path was verified correct end-to-end). The merchant then
> descoped the feature rather than depend on Shopify notification templates
> while uncertainty remains: **the entire feature was deleted from the
> codebase** — the upload pipeline (`uploadBouquetPhoto` +
> stagedUploadsCreate/fileCreate/status GraphQL documents), the
> `custom.bouquet_photo` `orderUpdate` write, the modal photo
> input/preview/helper text, the single-order restriction, the `photo`
> response field + toasts, and the §8-FST email-flow test item. Mark
> Fulfilled is now tracking fields + notify only.
>
> **Findings F1–F5: CLOSED BY REMOVAL.** Full historical detail (the traced
> execution path, the 10 code-verified audit answers, the findings table, the
> email-link disposition, and the F5 root-cause evidence chain) lives in the
> dated 2026-07-12 rows of `verification-log.md` and `changelog.md`; it was
> removed from this section because the audited code no longer exists. The
> feature may return as a **separate future enhancement** once there are
> clear product requirements and a proven architecture (that revival should
> start from the F1–F5 lessons in the logs).
>
> Residual (dev store only, harmless): test uploads remain in Admin → Content
> → Files, and test orders (e.g. #1009) keep a stale `custom.bouquet_photo`
> metafield — nothing reads either. The merchant should also delete any
> bouquet Liquid snippet already pasted into the Shipping confirmation
> template.

---

## G. §8-FST round-1 findings (2026-07-12, two confirming smoke runs): S9–S13

> All five were reported by the merchant with repro detail, root-caused in source
> (plus two live dev-store Admin-GraphQL probes for the search semantics), fixed
> the same day on explicit merchant instruction ("ayusin lahat"), and
> **live-verified in the embedded dev app 2026-07-12** before commit.

| # | Symptom | Root cause | Fix | Status |
|---|---------|-----------|-----|--------|
| S9 | "Send email" opens a blank "Untitled" tab; no compose window (the sole §8-FST FAIL; supersedes the S8 `external: true` fix) | Two stacked problems: (a) mailto + `target="_blank"` — Chrome opens the new tab as `about:blank`, and the external-protocol launch from that fresh tab is unreliable/silent, so the tab just sits blank; (b) Polaris `ActionList` **ignores the item `target` prop** (verified in `Item.js` — only `external` is forwarded to `UnstyledLink`), so the App Bridge-sanctioned `_top` navigation cannot be expressed declaratively. | Round 1: `onAction` building a synthetic `<a href="mailto:…" target="_top">` inside the user gesture — technically clean (no crash, no orphan tab) but **failed the merchant round-2 re-test: "walang nangyayari"**. See the round-2 addendum below; the shipped fix abandons mailto entirely. | ❌ round-1 fix superseded → ✅ round 2 (Gmail compose URL) live-verified 2026-07-12 |
| S10 | Archived orders still listed in "All" despite the Archive modal promising they'll be hidden | The loader sent **no `status:` term**, and the Admin GraphQL `orders` query defaults to ALL orders (open + closed). Probe on flowercart-dev confirmed: no-term → 5 orders incl. both archived; `status:open` → 2 (also drops the CANCELLED order — wrong for S11); **`-status:closed` → 3 (open + cancelled, no archived — matches the native admin 5→3 the merchant saw)**. | Loader: `-status:closed` appended for all/today/tomorrow/thisWeek; `status:open` for unfulfilled/unpaid (workqueues exclude cancelled too); new **Archived tab** = `status:closed` so bulk Unarchive stays reachable. | ✅ live-verified 2026-07-12 |
| S11 | Cancelled order (#1007) still shows "Unfulfilled" in list + panel | A cancelled order's `displayFulfillmentStatus` legitimately stays `UNFULFILLED` — every fulfillment badge rendered the raw status and nothing consulted the already-fetched `cancelledAt`. | `order-utils`: `isCancelled()`, `fulfillmentBadge()` (Cancelled/critical override), `isOpenDeliverableOrder()` (kills Today/Overdue chips on cancelled orders), `getDeliveryStatus()` returns Cancelled first. Wired into the IndexTable row, panel header, and DeliverySection; unfulfilled tab count + KPI exclude cancelled. Display-only — no action gating added (reschedule stays an administrative override per §10a). | ✅ live-verified 2026-07-12 |
| S12 | "This week" always zero despite upcoming deliveries | Week window was **Monday-start**: on Sunday Jul 12 the window was Mon Jul 6 – Sun Jul 12, excluding every upcoming delivery (e.g. Sat Jul 18). | `dateRefs` now computes a **Sunday→Saturday calendar week** (Jul 12 → window Jul 12–18). Same object feeds the tab filter and the tab count. | ✅ live-verified 2026-07-12 (#1009 rescheduled to Jul 18 → "This week (1)") |
| S13 | Search "Cancel" clears the text but the list stays filtered until navigating away | `IndexFilters` invokes ONLY `cancelAction.onAction` on Cancel (verified in Polaris source — it never calls `onQueryClear`), and ours was wired to a **no-op** `() => {}`, leaving the committed `?search=` applied with the search box hidden. | `cancelAction={{ onAction: onQueryClear }}` — the route's `handleQueryClear` already resets the draft AND deletes the URL param immediately. | ✅ live-verified 2026-07-12 |

### S9 round 2 (2026-07-12, merchant §8-FST re-run): mailto abandoned → Gmail compose URL

The round-1 mailto/`_top` fix survived every in-app check (no crash, no orphan
tab, no console errors) but produced **nothing visible** on the merchant
machine. Root cause is a dead mailto handler chain, confirmed outside the app:

- OS `mailto` association (`HKCU …\UrlAssociations\mailto\UserChoice`) =
  **`ChromeHTML`** — Windows hands mailto back to Chrome itself.
- Inside Chrome, **no webmail handler is registered** for mailto
  (`protocol_handler` prefs have no mailto entry; `custom_handlers: null`), so
  Chrome falls back to the OS default… which is Chrome. The circular handoff is
  silently dropped.

No mailto-based approach can work on such a machine, so the shipped fix removes
the OS dependency entirely: the Send email item is again a declarative link —
`url: https://mail.google.com/mail/?view=cm&fs=1&to=<email>&su=Order <name>`
with `external: true` (the same sanctioned `_blank` path "View order status
page" already uses). Gmail-specific by merchant decision (custom single-tenant
app; merchant runs on Gmail; chose this over a provider-choice popover and
copy-to-clipboard). Live-verified 2026-07-12: click → new tab → Gmail compose
with To + subject prefilled, admin intact, no console errors.

**Merchant re-check 2026-07-12: PASSED** — the compose opened on the
merchant's own machine and they sent a test message end-to-end ("Message
sent"). With this, **all five S9–S13 re-checks are merchant-confirmed**; S9 is
CLOSED. Successor design (in-app compose + server-side send via the business
Private Email mailbox) is locked in `customer-email-design.md` and ships
separately after the V2 closeout.

---

## How findings map to the migration (per orders-ops-v2-ux.md §8)

- Presentation bugs (**[rewrite-fixes]**) are resolved in **Phase 2** when the
  affected surface (modals, bulk bar, badges) is rewritten in Polaris React and
  wired to `useRevalidator`-based refresh (§6). No standalone patch.
- **[logic-bug]** findings are NOT bundled into the rewrite silently. Each is listed
  here with its root cause and waits for explicit approval before any change to the
  loader / action / services.
- **[cleanup]** items are deleted opportunistically during the phase that touches
  their file, and noted in the verification log.
