import type { LoaderFunctionArgs } from "react-router";

import {
  addDays,
  getMaxSelectableDate,
  getMinSelectableDate,
  getShopLocalDate,
  isDateBlocked,
  isIsoDateString,
  isSlotAtCapacity,
  isSlotAvailable,
  isSlotBlocked,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";

interface AvailabilityWindowSlot {
  available: boolean;
  blocked: boolean;
}

interface AvailabilityWindowDate {
  dateBlocked: boolean;
  slots: Record<string, AvailabilityWindowSlot>;
}

export interface AvailabilityWindow {
  today: string;
  minDate: string;
  maxDate: string;
  dates: Record<string, AvailabilityWindowDate>;
}

// Data only — the storefront renderer owns precedence:
//   dateBlocked > date before minDate (cutoff-passed today) > blocked > cutoff/prep.
// `blocked` is NOT ANDed into the window: it is the stable config + live-count
// verdict, while `available` is the full time-aware gate (cutoff + prepHours), so
// the two can legitimately disagree and the renderer needs both.
function buildAvailabilityWindow(
  rules: DeliveryScheduleRules,
  now: Date,
): AvailabilityWindow {
  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);

  // getShopLocalDate never throws but yields "" on failure; "" sorts before every
  // real date and would write a junk dates[""] key, so fall back to minDate.
  const shopToday = getShopLocalDate(rules.timezone, now);
  const today = isIsoDateString(shopToday) ? shopToday : minDate;

  // `dates` starts at TODAY, not minDate: past cutoff, today is still listed with
  // every slot available:false so the storefront can explain why (same behavior
  // as the cart widget). minDate/maxDate stay the true sellable window, so the
  // map may hold exactly one key earlier than minDate.
  const firstDate = today < minDate ? today : minDate;

  const dates: AvailabilityWindow["dates"] = {};
  for (let date = firstDate; date <= maxDate; date = addDays(date, 1)) {
    const slots: AvailabilityWindowDate["slots"] = {};
    for (const slot of rules.slots) {
      slots[slot.value] = {
        available: isSlotAvailable(rules, date, slot.value, now),
        blocked:
          isSlotBlocked(rules, date, slot.value) ||
          isSlotAtCapacity(rules, date, slot.value),
      };
    }
    dates[date] = { dateBlocked: isDateBlocked(rules, date), slots };
  }

  return { today, minDate, maxDate, dates };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The storefront app proxy reuses the shared rules service so theme code and app
  // surfaces read the same delivery window, blackout, and capacity contract.
  const { admin, session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;
  const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin);

  // One clock for the whole payload so every cutoff/prep evaluation agrees.
  const now = new Date();

  // Existing keys are spread first, untouched, so the storefront payload stays
  // byte-compatible (D5); `availabilityWindow` is appended after them.
  return Response.json(
    {
      ...scheduleRules,
      availabilityWindow: buildAvailabilityWindow(scheduleRules, now),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};
