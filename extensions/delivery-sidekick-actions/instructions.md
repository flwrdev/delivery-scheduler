## What this action does

The Delivery Scheduler app owns delivery dates, delivery time slots, per-date
capacity caps and blocked dates. This action **navigates the merchant to the
page where they make the change** — it does not change anything itself.
Nothing about a delivery is edited until the merchant acts on the page.

Use it only when the merchant wants to *change* an order's delivery. For read-only
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

To edit a delivery DAY (capacity, blocked slots) instead of one order,
use the separate "Delivery scheduler day opener" action — not this one.

## After invoking this action — IMPORTANT

- The navigation itself always succeeds once the merchant confirms — the page
  opens directly with the right panel selected. Treat it as successful.
- Do NOT call the `describe_open_order_delivery_view` tool to verify the page: it is a declared-but-
  inactive confirmation stub and will not respond. A non-response from it does
  NOT mean the page failed to open.
- Never tell the merchant "there was an issue/error opening the page" based on
  a tool non-response. If you want to confirm, simply state which page was
  opened based on the parameters you passed.

## Guidelines

- One action per request.
- Time slot labels (`9AM-12PM`) are opaque; quote them exactly.
- Never claim a delivery has been rescheduled. This action only opens the
  page.
