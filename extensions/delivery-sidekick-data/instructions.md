## What this app owns

The Delivery Scheduler app owns **when a flower order gets delivered**: the
delivery date, the delivery time slot (labels like `9AM-12PM`), the per-date
capacity caps, blocked dates and blocked slots, the same-day cutoff hour, the
prep lead time, and the reschedule state of an order. Shopify's own order data
does not carry any of this — always use these tools instead of guessing from
order tags or line items.

## Which tool to use

### `get_delivery_booked_counts` — "how full is a delivery day?"

Use for capacity questions:

- "Is Friday fully booked?" / "Can we take another delivery on 2026-08-22?"
- "How many slots are left on the 9AM-12PM run tomorrow?"
- "Which days next week still have delivery capacity?"

Pass `date` for one day, or `start_date`/`end_date` for a range. With no input
it returns the upcoming capacity-tracked dates starting today, in the shop's
delivery timezone.

**Always check `countsStatus` before answering.** Only `ok` means the numbers
are complete. On `partial` the booked figures are a **lower bound** (an order
scan hit a cap — see `truncatedDates`), on `error` there are no live counts at
all, and on `untracked` no capacity is configured anywhere. Relay `countsNote`
verbatim in those cases instead of presenting the numbers as final. If
`datesOmitted` is above zero, say so and offer to narrow the date range.

On `error` and `skipped` the `booked`, `remaining` and `full` fields come back
as **null** — say the booked figures are unavailable rather than reporting a
day as empty. `capacity` is still accurate on those statuses.

A date listed in `untrackedRequestedDates` has **no capacity cap configured at
all** — that is different from a day with capacity and no bookings. Say that
deliveries on that date are not capacity-limited and only the global rules
(cutoff, prep hours, booking window, blocked dates) apply; do not report it as
fully free or fully booked.

### `get_order_delivery` — "when is order #4111 going out?"

Use whenever the merchant names a specific order:

- "When is #4111 being delivered?" / "What slot is 4111 in?"
- "Has #4111 been rescheduled?" / "Is #4111 fulfilled yet?"

Pass the order number in `order_name`, with or without the leading `#`. Exactly
one order comes back. A `deliveryDate` of `null` means the order has no delivery
schedule on it at all — say that plainly rather than inventing a date. A
`deliverySyncStatus` starting with `attention:` means checkout-time validation
flagged the booking (for example over capacity) but let it through; mention it.
Offer `order.appUrl` when the merchant wants to change the delivery.

### `get_schedule_config_summary` — "how is delivery set up?"

Use for settings questions, not per-day capacity:

- "What's our same-day cutoff?" / "How far ahead can customers book?"
- "What delivery time slots do we offer?"
- "Which dates are closed for delivery?"

This tool is cheap and does no live order scan — prefer it whenever the answer
does not depend on how many orders are already booked. `cutoffHour` is an hour
of day (0-23) in `timezone`; `maxDays` is the booking window in days;
`prepHours` is the lead time a slot needs. `configHealthIssueCount` above zero
means the stored configuration has problems worth flagging to the merchant.

## Guidelines

- Dates are always `YYYY-MM-DD` and are interpreted in the shop's delivery
  `timezone`, which is not necessarily the merchant's browser timezone. Resolve
  "today"/"tomorrow" against the `today` field these tools return.
- Time slots are opaque labels (`9AM-12PM`). Quote them exactly; do not
  reformat, re-order or translate them.
- Every response carries `ok`. When `ok` is `false`, read `error` and tell the
  merchant what it says — do not retry the same call or fabricate a fallback.
- These tools are **read-only**. They cannot change a delivery date, move a
  slot, block a date or edit capacity. To make a change, use the app's actions
  to open the order or the scheduler in the Delivery Scheduler app.
