import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { getSessionShop } from "./session.server";

function getTodayString(timezone) {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

function getCapacityStatus(capacity, booked) {
  if (capacity <= 0) return { label: "Closed", tone: "neutral", rank: 3 };
  if (booked >= capacity) return { label: "Full", tone: "critical", rank: 0 };
  if (booked / capacity >= 0.8) return { label: "Filling fast", tone: "warning", rank: 1 };
  if (booked > 0) return { label: "Tracking", tone: "good", rank: 2 };
  return { label: "Open", tone: "good", rank: 4 };
}

function buildCapacityEntries(rules, today) {
  const slotLabelsByValue = new Map(rules.slots.map((slot) => [slot.value, slot.display]));

  return Object.entries(rules.slotCapacity)
    .filter(([date]) => date >= today)
    .flatMap(([date, capacities]) =>
      Object.entries(capacities).map(([slotValue, values]) => {
        const capacity = Number(values?.capacity) || 0;
        const booked = Number(values?.booked) || 0;
        const remaining = Math.max(capacity - booked, 0);
        const utilizationPercent =
          capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : 100;
        const status = getCapacityStatus(capacity, booked);

        return {
          date,
          slotValue,
          slotLabel: slotLabelsByValue.get(slotValue) ?? slotValue,
          capacity,
          booked,
          remaining,
          utilizationPercent,
          status,
        };
      }),
    )
    .sort((a, b) => {
      if (a.status.rank !== b.status.rank) return a.status.rank - b.status.rank;
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.utilizationPercent !== b.utilizationPercent) {
        return b.utilizationPercent - a.utilizationPercent;
      }
      return a.slotLabel.localeCompare(b.slotLabel);
    });
}

function countBlockedSlots(disabledSlots, today) {
  return Object.entries(disabledSlots).reduce((total, [date, slots]) => {
    if (date < today) return total;
    return total + slots.length;
  }, 0);
}

export async function getSchedulerData({ admin, session }) {
  const shop = getSessionShop(session);
  const rules = await getScheduleRulesWithBookedCounts(shop, admin);
  const today = getTodayString(rules.timezone);

  const upcomingBlockedDates = rules.disabledDates
    .filter((date) => date >= today)
    .sort();
  const blockedSlotDates = Object.entries(rules.disabledSlots)
    .filter(([date, slots]) => date >= today && slots.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, slots]) => ({ date, slots, slotCount: slots.length }));
  const capacityEntries = buildCapacityEntries(rules, today);
  const fullCount = capacityEntries.filter((entry) => entry.status.label === "Full").length;
  const nearLimitCount = capacityEntries.filter(
    (entry) => entry.status.label === "Filling fast",
  ).length;
  const trackedCapacityDayCount = new Set(capacityEntries.map((entry) => entry.date)).size;

  return {
    shop,
    rules: {
      timezone: rules.timezone,
      cutoffHour: rules.cutoffHour,
      prepHours: rules.prepHours,
      maxDays: rules.maxDays,
      slots: rules.slots,
    },
    metrics: {
      slotCount: rules.slots.length,
      blockedDateCount: upcomingBlockedDates.length,
      blockedSlotCount: countBlockedSlots(rules.disabledSlots, today),
      trackedCapacityDayCount,
      fullCount,
      nearLimitCount,
    },
    upcomingBlockedDates: upcomingBlockedDates.slice(0, 6),
    blockedSlotDates: blockedSlotDates.slice(0, 4),
    watchlist: capacityEntries.slice(0, 6),
    today,
  };
}
