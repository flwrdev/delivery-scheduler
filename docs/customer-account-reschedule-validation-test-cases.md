# Customer Account Reschedule Validation Test Cases

Phase 1 adds server-side validation only. Cart UI behavior remains the reference contract.

## Core parity cases

1. Same-day before cutoff
   - Given current shop time is before `cutoffHour`
   - When the customer submits today's date with a slot whose start time is at least `prepHours` away
   - Then the route accepts the reschedule

2. Same-day after cutoff
   - Given current shop time is at or after `cutoffHour`
   - When the customer submits today's date
   - Then the route rejects it with `Same-day delivery cutoff passed. Choose tomorrow.`

3. Prep window violation
   - Given current shop time is before cutoff
   - And the chosen same-day slot starts fewer than `prepHours` from now
   - Then the route rejects it with `Selected time slot is unavailable. Please choose another time slot.`

4. Blocked date
   - Given the selected date exists in `disabledDates`
   - When the customer submits that date
   - Then the route rejects it with `Selected delivery date is unavailable. Please choose another date.`

5. Date outside max day window
   - Given the selected date is after `minDate + maxDays - 1`
   - When the customer submits that date
   - Then the route rejects it with the current delivery window message

6. Blocked slot
   - Given the selected date is valid
   - And the selected slot is listed in `disabledSlots[date]`
   - Then the route rejects it with `Selected time slot is unavailable. Please choose another time slot.`

7. Slot at capacity
   - Given the selected date and slot are configured in `slotCapacity`
   - And `booked >= capacity`
   - Then the route rejects it with `Selected time slot is unavailable. Please choose another time slot.`

8. Unknown slot
   - Given the submitted slot does not exist in `rules.slots`
   - Then the route rejects it with `Selected time slot is unavailable. Please choose another time slot.`

9. No slots left for a valid date
   - Given a valid date where every configured slot is unavailable
   - Then the route rejects it with `No delivery slots available for this date. Choose another date.`

10. Timezone parity

- Given the shop timezone is `Asia/Manila`
- When current UTC date differs from Manila date
- Then min date and same-day cutoff evaluation still follow Manila time rather than server local time or browser local time
