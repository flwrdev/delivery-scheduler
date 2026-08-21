# Delivery Scheduler — App Context for External Research

> **Purpose:** static reference for the daily Shopify feature-research agent
> (see `docs/shopify-feature-research-findings.md` for its dated output). This
> file is NOT part of the architecture docs set and is NOT covered by the
> CLAUDE.md docs-first/update-after loop — it's a research aid only. If the
> app's feature set changes materially, update this file so future research
> runs don't waste a recommendation on something already built.

## Business context

- Merchant: flowercart.store — online flower shop on Shopify (Dawn theme),
  ₱400-500k/month revenue.
- Target customers: men and women 24-39, Metro Manila, last-minute buyers.
  They care about: convenience, attractive bouquets, reliable same-day
  delivery, fast/easy checkout.
- Owner's stated priority: focus on improvements that grow the business; be
  creative and direct, minimize unnecessary guardrails/rules.

## What this app already does (do not recommend anything already built)

**Core architecture:** Shopify embedded app, React Router 7 (ported from the
Shopify Remix template), Polaris React admin UI, Prisma + Postgres (Neon) for
app-side state, deployed on Google Cloud Run. Admin GraphQL API version
2026-04. Delivery date/time-slot state lives on the SHOPIFY ORDER itself
(metafields, tags, customAttributes) — Postgres only holds side-tables /
conversation logs (13 Prisma models: sessions, scheduler config, Messenger
bot conversation pair, Lalamove courier-tracking correlation table,
customer-email send log, occasion-reminder trio, support-chat trio, an
anti-guessing lockout table). Booked-slot counts are always live-computed via
Admin GraphQL (60s in-process cache), never persisted.

**Features already fully built and live in production:**

1. **Delivery date/time-slot scheduling** at checkout with per-date/per-slot
   capacity limits, blocked dates/slots, cutoff hour + prep-hours lead time,
   configurable via a Polaris admin settings page (`/app/scheduler`) with
   granular per-section saves and optimistic-concurrency version guards.
2. **Orders Operations admin UI** (`/app/orders`) — a Polaris React order
   list + detail side-panel (IndexTable/IndexFilters), with bulk actions
   (archive/cancel/tag/mark-fulfilled/reschedule), a delivery timeline
   showing reschedule/fulfillment/email history, and a merchant
   "administrative override" reschedule flow (bypasses the customer-facing
   self-service restrictions).
3. **Customer-account self-service reschedule** — a customer-account UI
   extension letting a signed-in customer reschedule their own delivery ONCE
   (locked via a tag after use), gated by cutoff/prep/capacity rules.
4. **In-app customer email** — merchant composes and sends plain-text emails
   to customers from the order panel, sent server-side via the merchant's own
   business-domain SMTP mailbox (Namecheap Private Email, via nodemailer) —
   not Gmail API (rejected due to OAuth verification burden for a
   single-tenant app). Supports up to 3 photo attachments.
5. **Automated occasion-reminder emails** — a nightly Cloud Scheduler job
   emails customers 7 and 3 days before an anniversary/birthday recurs (based
   on last year's order), with a discount code on the 3-day email,
   unsubscribe link, merchant-editable templates, and conversion tracking.
6. **COD (Cash on Delivery) handling** — a Shopify Checkout Function
   (Payment Customization) that hides the COD payment method outside a
   configured NCR (Metro Manila) ZIP/city + subtotal window; a COD
   convenience fee auto-added and shown on the Thank You page; admin settings
   page for the fee amount and eligibility window.
7. **Lalamove courier status listener** — NOT dispatch (courier booking
   itself is done via Shopify's official Lalamove app) — a narrow, read-only
   poller that watches a merchant-pasted Lalamove Order ID and auto-marks the
   Shopify fulfillment "Delivered" once Lalamove reports completion (polling
   every 10 min; Lalamove's push webhooks were found not to fire for this
   account's booking flow).
8. **Shopify Sidekick (admin AI assistant) integration** — 3 read-only
   Sidekick tools (booked counts, single-order delivery status, schedule
   config summary) + 2 Sidekick deep-link actions (`admin.app.intent.link`)
   that open the relevant admin page for the merchant to make a change by
   hand. No writes from Sidekick itself yet.
9. **A full conversational AI sales/support agent on Facebook Messenger**
   ("FlowerBot", built on Claude/Anthropic's API) — handles product discovery
   (search/filter/best-sellers/typo-tolerant fuzzy match), delivery-slot
   lookup, ORDER CREATION via Shopify draft orders (idempotent, checkout
   completes payment), add-on upsell, abandoned-cart-style follow-up nudges,
   human-agent takeover detection, image recognition (photo of a bouquet
   matched to catalog products), and order-status lookup.
10. **A customer-account AI support chat** — shares the same underlying
    "agent brain"/LLM tool-loop as the Messenger bot, but is READ-ONLY in v1
    (no ordering capability on this channel — Messenger is still the only
    channel that can create orders). Built but NOT YET DEPLOYED to
    production.
11. **11 total Shopify extensions**: 1 Checkout UI Function (COD
    eligibility), 2 post-purchase Thank You page blocks (delivery info + COD
    fee notice), 2 customer-account extensions (delivery date display block +
    reschedule action), 2 read-only admin order-page extensions, 3 Sidekick
    extensions (data/actions/scheduler-intent), 1 customer-account
    support-chat extension.
12. **Order-tag-based visual timeline** (reschedule/address-edit/
    fulfillment-tracked events encoded as dated tags, since Shopify order
    tags have no native timestamp/ordering) and an **in-app editable-shipping
    -address flow** (Edit details modal with Google Places autocomplete for
    address search).

**Explicitly NOT used / not built (real gaps, useful to know for research):**

- **No Delivery Customization Function** and **no Pickup Point Delivery
  Option Generator Function** — the only Shopify Function in this app is
  Payment Customization (for COD). Same-day slot availability is NOT
  reflected in Shopify's native delivery-option step at checkout; it's
  handled entirely by this app's own custom date/slot picker UI.
- Courier dispatch/booking automation stays 100% manual via the official
  Lalamove app — a past custom Lalamove dispatch integration was removed and
  must not be reintroduced.
- Ordering via the customer-account/storefront support chat is not available
  (Messenger-only for now).
- No full communications/campaign-sending page, no HTML-branded marketing
  emails, no bulk/campaign email sending.
- No proactive SMS/WhatsApp customer notifications (courier status updates
  stay internal — they update the Shopify order but don't message the
  customer).
