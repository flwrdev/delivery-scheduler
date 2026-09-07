# Customer Email — in-app compose + server-side send (design)

> Part of the docs set. Source of truth for the feature design. System topology:
> [architecture.md](./architecture.md) · route/auth contract: [api.md](./api.md).

**Status: IMPLEMENTED + LIVE-VERIFIED 2026-07-13** on `feature/customer-email`
(design locked 2026-07-12, merchant-approved). Both live-smoke paths passed —
happy (arrival Gmail-API-verified + merchant-confirmed) and wrong-password
(in-modal error, no crash). One design amendment was forced by the live smoke —
see the §4 note on op failure statuses (200 + ok:false, never 5xx). **Deployed
to production 2026-07-13** (Cloud Run rev `00159-dmp`, Secret Manager wired) and
merchant-verified on a real order the same day. **Amended 2026-07-14: photo
attachments (§2a)** — merchant-requested; customers ask for an actual photo of
their order before it ships. **§2a implemented + live-verified 2026-07-14**:
photo-less send re-verified through the new multipart path in the dev app
(arrival + BCC copy merchant-confirmed); with-photo two-send verified against
real Private Email SMTP — customer copy WITH the JPEG (Gmail
metadata-confirmed), business-mailbox copy WITHOUT it + the filename marker
(merchant-confirmed in webmail).

---

## 1. Goal & background

The Order Details panel's "Send email" action currently opens a **Gmail
compose tab** (S9 round 2, audit §G) — reliable, but it leaves the app and
assumes the merchant's Gmail. The merchant's original expectation was the
native Shopify admin experience: compose INSIDE the app, and the system sends
the email itself.

This feature delivers that: a compose modal in the panel, sent server-side
through the merchant's **business mailbox on Namecheap Private Email** via
plain SMTP.

**Why not the Gmail API** (researched 2026-07-12, sources in the verification
log row): `gmail.send` is a Google "sensitive" OAuth scope — production use
requires Google app verification (privacy policy, homepage, weeks-long
review), and the verification-free "Testing" mode revokes refresh tokens every
7 days. Unworkable for a single-tenant custom app.

**Why Private Email SMTP**: designed for standard SMTP AUTH — no OAuth, no
verification program, no token expiry. Branded business sender (better
deliverability than personal Gmail: the domain's SPF/DKIM already align with
privateemail servers). Limits far exceed need: 500 outgoing emails/hour per
domain (Starter/Private/Business plans), 50 recipients per message.

## 2. Locked decisions

| # | Decision | Choice (alternatives rejected) |
|---|----------|--------------------------------|
| E-1 | Email provider / transport | **Business mailbox on Namecheap Private Email, plain SMTP AUTH via nodemailer** (`mail.privateemail.com:465` SSL). Rejected: Gmail API (verification burden, §1), Gmail SMTP app password (personal sender), transactional services (can't send as the business mailbox without DNS work; revisit only if volume outgrows Private Email). |
| E-2 | Compose entry point | **The panel's existing "Send email" action opens an in-app Polaris compose modal** (replaces the Gmail-tab link). The send service is written reusable so the planned Communications page can call it later. Rejected: waiting for the new page (no in-app send until then). |
| E-3 | Sent copy | **Auto-BCC the sender mailbox on every send** — the copy lands in the merchant inbox (filterable to a folder). Rejected: IMAP-append to Sent (extra connection + failure point), no copy. |
| E-4 | Recipient trust | **The server NEVER trusts a client-supplied recipient.** The op receives an order id, re-reads the customer email from Admin GraphQL, and sends only there. The endpoint cannot be used as an arbitrary-recipient relay. |
| E-5 | Order-state writes | **None to the Shopify order** — still no metafield, no tag, no Shopify order timeline. `/app/orders` stays a 4-write-path route per api.md §2. **Revisited 2026-08-17:** the order panel's `DeliveryTimeline` now also shows fulfilled/delivered/email-sent activity, so a successful send now writes one row to a new Postgres-only `EmailSendLog` table (shop, order id, recipient, subject, sent-at) — never the Shopify order, so the §2 write-path contract is unchanged. A log-write failure never fails the send response (same guarded posture as `LalamoveTracking`'s writes). |
| E-6 | Message format | **Plain text** body (merchant-typed), subject prefilled `Order #XXXX`. HTML branding/templates are future scope (§7). |
| E-7 | Sequencing | Separate branch `feature/customer-email`, implemented only after the V2 §8-FST closeout. New dependency `nodemailer` (+ `@types/nodemailer` dev). |

## 2a. Amendment — photo attachments (2026-07-14, merchant-requested)

Use case: customers request an **actual photo of their prepared order** (the
bouquet) before it ships. The compose modal gains an optional photo upload.

| # | Decision | Choice (alternatives rejected) |
|---|----------|--------------------------------|
| E-8 | Photo attachments | **Up to 3 photos per email, JPEG/PNG/WebP, ≤ 8 MB each, ≤ 15 MB total.** The caps keep the multipart request comfortably under Cloud Run's 32 MB request limit and the base64-encoded message (~+37%) well under provider message-size limits. Client-side validation is UX only — the server re-validates count, MIME type, and sizes and rejects violations with a 400. Rejected: Shopify Files/CDN link instead of attaching (extra write surface + link rot; the removed Bouquet Photo feature's F1–F5 lessons argue for keeping this fully inside our own SMTP pipeline). |
| E-9 | Sent copy vs photos (amends E-3) | **When photos are attached, the send becomes TWO messages:** (1) the customer message WITH the photos, no BCC; (2) a merchant self-copy WITHOUT the photos — same subject/body plus an appended marker line listing the photo filenames (`[N photo(s) sent to the customer: … — not attached to this copy]`). Merchant decision 2026-07-14: keep photo bytes out of the Private Email mailbox to protect its storage quota. Photo-less sends keep the original single send + BCC (E-3 unchanged). The self-copy is **best-effort**: if it fails after the customer send succeeded, the op still reports success, with a "couldn't save a copy to your mailbox" note in the toast — the customer-facing send is the one that matters. |

Transport detail: the modal submits `multipart/form-data` (repeated `photo`
fields); the route action's existing `request.formData()` parses multipart
natively (undici), so the `sendEmail` op dispatch is unchanged — only
`handleSendEmailOp` gains the photo validation + Buffer conversion, and
`sendCustomerEmail` gains the two-send logic.

## 3. Configuration (merchant-only setup — stop-and-ask gate)

New environment variables (local `.env` for dev; **Secret Manager → Cloud Run
env** for production, same handling as existing secrets):

| Var | Value | Notes |
|-----|-------|-------|
| `EMAIL_SMTP_HOST` | `mail.privateemail.com` | could be hardcoded, but env keeps provider swappable |
| `EMAIL_SMTP_PORT` | `465` | SSL (`secure: true`); 587/STARTTLS is the fallback if 465 is egress-blocked |
| `EMAIL_SMTP_USER` | full business email address | also the SMTP login |
| `EMAIL_SMTP_PASSWORD` | mailbox password (or app password if the mailbox has 2FA) | **never in repo, chat, or logs** |
| `EMAIL_FROM_NAME` | e.g. `The Flowercart` | display name; From = `EMAIL_FROM_NAME <EMAIL_SMTP_USER>` |

**Config gating:** if `EMAIL_SMTP_USER`/`EMAIL_SMTP_PASSWORD` are absent, the
op returns a clear error ("Email sending is not configured on this
environment") which the modal surfaces — no crash, no silent failure. This is
the expected state on fresh dev checkouts until the merchant provisions
secrets.

## 4. Architecture

### New service — `app/services/send-customer-email.server.ts`

`sendCustomerEmail({ to, subject, textBody })`:

1. Builds one nodemailer transport from env (module-level lazy singleton —
   Cloud Run instances are reused; do not reconnect per send).
2. `sendMail({ from, to, bcc: EMAIL_SMTP_USER, subject, text })` (E-3, E-6).
3. Returns `{ ok: true }` or `{ ok: false, error }` — nodemailer errors are
   caught and mapped to a human-readable message (auth failure, connection
   timeout, provider rejection e.g. hourly limit).

No retry queue: a failed send is reported to the merchant immediately and they
resend manually (single-operator workflow; fire-once matches the mental model).

### New op — `sendEmail` in the `app.orders.tsx` action

Same `_action` dispatch pattern as archive/cancel/markFulfilled/reschedule.
Single-order only (bulk email is explicitly out of scope — E-4/E-6 assume a
personally-typed message).

Server steps: session auth (`authenticate.admin`, inherited) → parse
`orderId`, `subject`, `body` → validate: both non-empty after trim, subject
≤ 200 chars, body ≤ 5 000 chars → **re-read the order's
`customer.defaultEmailAddress.emailAddress` via Admin GraphQL** (E-4; 400 if
the order has no customer email) → `sendCustomerEmail(...)` → typed response
`{ ok, message }` for the toast/banner layer.

> **Amended 2026-07-13 (live-smoke finding):** upstream failures (order read,
> SMTP send) respond **`200 + ok:false`, never 5xx** — Cloudflare replaces
> origin 502/504 bodies with its branded HTML error page (observed through the
> dev tunnel), which breaks the fetcher JSON contract and crashes the embedded
> iframe to "Bad gateway". Validation errors stay 4xx (passed through
> untouched). Same failure shape as the bulk ops.

### New UI — `SendEmailModal` (panel)

- Panel Actions → "Send email" opens the modal (replaces the Gmail-URL link;
  still disabled when the order has no customer email).
- Fields: **To** read-only (customer email) · **Subject** text field,
  prefilled `Order #XXXX` · **Body** multiline (≈6 rows), empty.
- **Send email** primary (loading while the fetcher is in flight, disabled
  until subject + body are non-empty) · **Cancel**.
- Success → success toast ("Email sent to <address>") + modal closes.
  Failure → error banner INSIDE the modal (the typed message is never lost);
  fields stay editable for retry.
- Runs under the same `activeModal` regime as the other modals, so the §6
  smart-refresh pause covers it (a background revalidate never yanks the form).

## 5. Security & privacy

- Credentials only in Secret Manager / local `.env` (never logged; nodemailer
  transport configured with `logger: false`).
- Recipient locked server-side to the order's customer email (E-4).
- Session-authenticated embedded-admin route — same auth surface as every
  existing orders op (api.md §1).
- Plain-text send — no HTML assembly, no injection surface.
- Provider limit (500/hr) is two orders of magnitude above realistic use; no
  app-side rate limiter.

## 6. Test plan

- **Unit (vitest):** op validation (missing/oversized subject+body, missing
  customer email → 400 paths); service param mapping with a mocked transport
  (From/To/BCC/subject/text all pinned, incl. the BCC-self invariant E-3);
  config-gating error when env vars are absent.
- **Live smoke (dev store):** dev orders' customer email is the merchant's own
  Gmail — send a real email from the panel of a test order, then verify:
  (1) success toast; (2) mail arrives at the customer address; (3) the BCC
  copy arrives at the business mailbox; (4) failure path by pointing
  `EMAIL_SMTP_PASSWORD` at a wrong value locally → in-modal error, no crash.

## 7. Out of scope (future enhancements, in likely order)

> **2026-08-21 → reverted 2026-08-28:** the "delivery reminder" idea in #1 was
> built as the **occasion reminder emails** feature (ADR-19) but **removed from
> the codebase on 2026-08-28** — it detected nothing (year-over-year design vs.
> pre-migration orders that had no `custom.date` metafield) and the merchant
> moved to a dedicated third-party Shopify reminder app. See
> [decisions.md ADR-19](./decisions.md) (Reverted note). `sendCustomerEmail` +
> `EmailSendLog` remain for the manual compose-email feature.

1. **Template presets** (reschedule confirmation / delay notice / delivery
   reminder) prefilled from order data — natural once the modal exists.
2. **Communications page** — the merchant's planned dedicated page (decongest
   Orders Operations); reuses `sendCustomerEmail` + the modal. Send history now
   exists (`EmailSendLog`, E-5 revisit 2026-08-17) — this page could read the
   same table instead of a per-order view.
3. HTML-branded emails; IMAP-append to Sent; bulk/campaign sending (likely
   never — that's a marketing-tool job).

## 8. Docs to update at ship

- api.md: routes table (+ explicit note: `sendEmail` is NOT a delivery write
  path — §2 table unchanged) · architecture.md: outbound-email side-effect
  note · decisions.md: ADR (in-app email via merchant business SMTP; Gmail API
  rejected) · changelog.md + verification-log.md rows · this doc's status line.

## 8. Second sender: the merchant-reschedule notice (2026-09-04)

The compose modal stayed the only *manual* sender. A second, *automatic*
sender now rides the same pipeline: when the merchant reschedules an order
from `/app/orders` with the modal's "Email the customer about the new
schedule" checkbox on (default), the bulk executor calls
`sendRescheduleNotice` (`app/services/reschedule-notice.server.ts`) after —
and only after — the canonical delivery write succeeded.

- **Same transport, same envelope.** It calls `sendCustomerEmail`, so From,
  the BCC-self copy (E-3), timeouts, and error humanizing are unchanged. No
  photos. Plain text: greeting by first name, "New delivery: Mon, Sep 28,
  2026, 9AM-12PM", "Previous: …" when it differs, a reply-to-this-email line,
  and the `EMAIL_FROM_NAME` signature.
- **E-4 holds.** The recipient is the order's customer email read by the
  executor's own Admin GraphQL state query (`customer.defaultEmailAddress`,
  then `order.email`), never a client-supplied address. No email → skipped,
  reported as "No customer email on file".
- **E-5 holds.** Still no Shopify order write for the email itself; a
  successful send writes the same `EmailSendLog` row the compose op writes, so
  the panel timeline shows "Email sent to …" under the reschedule entry.
- **Never a failure.** The outcome (`sent` / `skipped_no_email` / `failed`) is
  appended to the item's message while `success` stays true — an SMTP hiccup
  must not read as a failed reschedule, and a Cloud Tasks retry must not
  re-run the write just to re-send. Runs identically on the inline path and
  the worker (same executor, same env).
- **Not sent** for the customer's own self-service reschedule (they did it
  themselves in the modal) and when the write was a no-op ("already at the
  selected date and slot").
- **Volume.** At most one email per rescheduled order; a 100-order bulk move
  is 100 sends against the provider's 500/hour — no queue needed.

Design record: decisions.md ADR-23 addendum.
