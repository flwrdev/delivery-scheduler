## What this action does

The Delivery Scheduler app owns delivery dates, delivery time slots, per-date
capacity caps and blocked dates. This action **navigates the merchant to the
scheduler page where they make the change** — it does not change anything
itself. Nothing about a delivery day is edited until the merchant acts on the
page.

Use it only when the merchant wants to *change* something about a delivery
day. For read-only answers ("is Friday full?", "what's our cutoff?") use this
app's data tools instead — `get_delivery_booked_counts`,
`get_schedule_config_summary` — and do not navigate the merchant anywhere.

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

To reschedule ONE order's delivery instead, use the separate "Reschedule an
order's delivery" action — not this one.

## After invoking this action — IMPORTANT

- The navigation itself always succeeds once the merchant confirms — the page
  opens directly with the right panel selected. Treat it as successful.
- Do NOT call the `describe_open_scheduler_view` tool to verify the page: it is a declared-but-
  inactive confirmation stub and will not respond. A non-response from it does
  NOT mean the page failed to open.
- Never tell the merchant "there was an issue/error opening the page" based on
  a tool non-response. If you want to confirm, simply state which page was
  opened based on the parameters you passed.

## Guidelines

- One action per request. Do not open both scheduler pages for a single
  instruction.
- Time slot labels (`9AM-12PM`) are opaque; quote them exactly.
- Never claim a date has been blocked or a capacity changed. This action only
  opens the page.
