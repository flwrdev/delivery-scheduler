## What these actions do

The Delivery Scheduler app owns delivery dates, delivery time slots, per-date
capacity caps and blocked dates. These actions **navigate the merchant to the
page where they make the change** — they do not change anything themselves.
Nothing about a delivery is edited until the merchant acts on the page.

Use them only when the merchant wants to *change* something. For read-only
answers ("when is #4111 delivered?", "is Friday full?", "what's our cutoff?")
use this app's data tools instead — `get_order_delivery`,
`get_delivery_booked_counts`, `get_schedule_config_summary` — and do not
navigate the merchant anywhere.

## Reschedule an order's delivery

Opens that order's delivery panel in the Delivery Scheduler app, ready for
"Update delivery slot".

Use when the merchant says things like:

- "Move #4111 to Saturday" / "Reschedule order 4111"
- "Change the delivery time on #4111 to the afternoon slot"
- "The customer for #4111 wants a different delivery day"

Pass the **numeric Shopify order id** as the intent value (the trailing number
of the order GID). Also pass `order_name` — the order number with its leading
hash, e.g. `#4111` — so the orders list filters down to that order and the panel
is guaranteed to open. If you only know the order number, look the order up
with `get_order_delivery` first: its `legacyId` is the value to pass.

Note the merchant may still need to pick the new date and slot on the page —
say so rather than implying the reschedule is already done.

## Open the delivery scheduler on a date

Opens the scheduler with that day's panel selected, where per-slot capacity,
blocked slots and the day override are edited.

Use when the merchant says things like:

- "Block deliveries on 2026-08-22" / "Close Sunday for delivery"
- "Raise the capacity for Friday's 9AM-12PM slot"
- "Set up the delivery slots for Valentine's day"

Pass the date as the intent value in `YYYY-MM-DD` format, in the store's
delivery timezone. If the merchant said "Friday" or "next Tuesday", resolve it
against the `today` field returned by `get_delivery_booked_counts` or the
`timezone` from `get_schedule_config_summary` — not the browser's clock.

## Guidelines

- One action per request. Do not open both pages for a single instruction.
- Time slot labels (`9AM-12PM`) are opaque; quote them exactly.
- Never claim a delivery has been rescheduled, a date blocked, or a capacity
  changed. These actions only open the page.
