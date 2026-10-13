import { getShopLocalDate } from "../../../../app/lib/delivery-availability";
import {
  formatShopLocalTime,
  formatShortMonthDay,
  shiftISODate,
} from "../../../../app/lib/recent-reschedules";

/** "3:05 PM", "Yesterday · 3:05 PM" or "Oct 6 · 3:05 PM" in the shop timezone. */
export function whenLabel(iso, timezone, todayISO) {
  const time = formatShopLocalTime(iso, timezone);
  const day = getShopLocalDate(timezone, new Date(iso));
  if (day === todayISO) return time;
  if (day === shiftISODate(todayISO, -1)) return `Yesterday · ${time}`;
  return `${formatShortMonthDay(day)} · ${time}`;
}

/** Plain-text email body, one paragraph per blank-line-separated block. */
export function EmailText({ text }) {
  const paragraphs = (text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <s-stack gap="small-200">
      {paragraphs.map((p, i) => (
        <s-paragraph key={i}>{p}</s-paragraph>
      ))}
    </s-stack>
  );
}
