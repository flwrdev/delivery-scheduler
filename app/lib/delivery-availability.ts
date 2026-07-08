export interface DeliveryScheduleSlot {
  display: string;
  value: string;
}

export interface DeliveryScheduleCapacity {
  capacity: number;
  booked: number;
}

export interface DeliveryScheduleRules {
  timezone: string;
  cutoffHour: number;
  prepHours: number;
  maxDays: number;
  slots: DeliveryScheduleSlot[];
  disabledDates: string[];
  disabledSlots: Record<string, string[]>;
  slotCapacity: Record<string, Record<string, DeliveryScheduleCapacity>>;
}

export interface DeliveryValidationItem {
  sku?: unknown;
  tags?: unknown;
  productTags?: unknown;
  mothersDayEligible?: unknown;
}

// Mother's Day rush dates are hard business rules layered over merchant-editable slots.
export const MOTHERS_DAY_RUSH_DATES = [
  "2026-05-09",
  "2026-05-10",
  "2026-05-11",
];
export const MOTHERS_DAY_RUSH_TIME_SLOTS: DeliveryScheduleSlot[] = [
  { display: "8:00 AM - 1:00 PM", value: "8:00 AM - 1:00 PM" },
  { display: "1:00 PM - 7:00 PM", value: "1:00 PM - 7:00 PM" },
];
export const MOTHERS_DAY_PRODUCT_TAG = "may10";
export const MOTHERS_DAY_PRODUCT_ERROR_MESSAGE =
  "Sorry, this item is not available for Mother's Day rush dates. Please choose another delivery date or select from our Mother's Day Collection.";
export const MOTHERS_DAY_RESCHEDULE_ERROR_MESSAGE =
  "Rescheduling is only allowed up to 2 days before the delivery date. Mother's Day rush dates are only available for selected Mother's Day products.";

const MOTHERS_DAY_ALLOWED_SKUS = new Set(
  Array.from(
    { length: 20 },
    (_, index) => `md${String(index + 1).padStart(2, "0")}`,
  ),
);
const LEGACY_DELIVERY_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}\s*\|\s*.+$/;
const DELIVERY_TIME_SLOT_TAG_PATTERN =
  /^\d{1,2}(?::\d{2})?\s*(?:AM|PM)\s*-\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i;

// Provide one safe fallback contract so both server routes and extensions can keep
// validating delivery choices even if a shop-specific rules record is unavailable.
export const DEFAULT_DELIVERY_SCHEDULE_RULES: DeliveryScheduleRules = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "12PM-3PM", value: "12PM-3PM" },
    { display: "3PM-6PM", value: "3PM-6PM" },
    { display: "6PM-11PM", value: "6PM-11PM" },
  ],
  disabledDates: [],
  disabledSlots: {},
  slotCapacity: {},
};

export function cloneDeliveryScheduleRules(
  rules: DeliveryScheduleRules,
): DeliveryScheduleRules {
  return {
    ...rules,
    slots: rules.slots.map((slot) => ({ ...slot })),
    disabledDates: [...rules.disabledDates],
    disabledSlots: Object.fromEntries(
      Object.entries(rules.disabledSlots).map(([date, slots]) => [
        date,
        [...slots],
      ]),
    ),
    slotCapacity: Object.fromEntries(
      Object.entries(rules.slotCapacity).map(([date, capacities]) => [
        date,
        Object.fromEntries(
          Object.entries(capacities).map(([slot, values]) => [
            slot,
            { ...values },
          ]),
        ),
      ]),
    ),
  };
}

export type DeliverySelectionValidationCode =
  | "invalid_date"
  | "date_before_min"
  | "date_after_max"
  | "date_blocked"
  | "slot_unknown"
  | "slot_unavailable"
  | "no_slots_available";

export type DeliveryDateValidationResult =
  | {
      ok: true;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
      message: string;
    }
  | {
      ok: false;
      code:
        | "invalid_date"
        | "date_before_min"
        | "date_after_max"
        | "date_blocked"
        | "no_slots_available";
      message: string;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    };

export type DeliverySelectionValidationResult =
  | {
      ok: true;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    }
  | {
      ok: false;
      code: DeliverySelectionValidationCode;
      message: string;
      minDate: string;
      maxDate: string;
      availableSlots: DeliveryScheduleSlot[];
    };

type ZonedNowParts = {
  date: string;
  minutes: number;
};

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function padNumber(value: number) {
  return String(value).padStart(2, "0");
}

function getFormatter(timezone: string) {
  const cached = zonedDateTimeFormatters.get(timezone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  zonedDateTimeFormatters.set(timezone, formatter);
  return formatter;
}

// Convert "now" into shop-local calendar parts so delivery cutoffs are evaluated in
// the merchant's timezone instead of the server or browser timezone.
function getZonedNowParts(timezone: string, now = new Date()): ZonedNowParts {
  const parts = getFormatter(timezone).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  return {
    date: `${year}-${month}-${day}`,
    minutes: hour * MINUTES_PER_HOUR + minute,
  };
}

export function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDateOrdinal(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day));
  nextDate.setUTCDate(nextDate.getUTCDate() + days);

  return [
    nextDate.getUTCFullYear(),
    padNumber(nextDate.getUTCMonth() + 1),
    padNumber(nextDate.getUTCDate()),
  ].join("-");
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isDeliveryTimeSlotTag(
  value: string | null | undefined,
): boolean {
  return DELIVERY_TIME_SLOT_TAG_PATTERN.test(normalizedString(value));
}

export function isDeliveryScheduleTag(
  value: string | null | undefined,
): boolean {
  const tag = normalizedString(value);
  if (!tag) return false;

  const lowerTag = tag.toLowerCase();
  return (
    lowerTag.startsWith("delivery:") ||
    lowerTag.startsWith("delivery date:") ||
    lowerTag.startsWith("delivery time:") ||
    LEGACY_DELIVERY_TAG_PATTERN.test(tag) ||
    isIsoDateString(tag) ||
    isDeliveryTimeSlotTag(tag)
  );
}

function normalizeSku(value: unknown): string {
  return normalizedString(value).toLowerCase();
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((tag) => normalizedString(tag).toLowerCase())
      .filter(Boolean);
  }

  const tagValue = normalizedString(value);
  return tagValue ? [tagValue.toLowerCase()] : [];
}

export function isMothersDayRushDate(date: string | null | undefined): boolean {
  return (
    typeof date === "string" && MOTHERS_DAY_RUSH_DATES.includes(date.trim())
  );
}

export function getAvailableTimeSlots(
  date: string | null | undefined,
  rules: DeliveryScheduleRules = DEFAULT_DELIVERY_SCHEDULE_RULES,
): DeliveryScheduleSlot[] {
  if (isMothersDayRushDate(date)) {
    return MOTHERS_DAY_RUSH_TIME_SLOTS.map((slot) => ({ ...slot }));
  }

  return rules.slots.map((slot) => ({ ...slot }));
}

export function isMothersDayEligibleItem(
  item: DeliveryValidationItem,
): boolean {
  if (item.mothersDayEligible === true) {
    return true;
  }

  const tags = [
    ...normalizeTags(item.productTags),
    ...normalizeTags(item.tags),
  ];
  if (tags.includes(MOTHERS_DAY_PRODUCT_TAG)) {
    return true;
  }

  return MOTHERS_DAY_ALLOWED_SKUS.has(normalizeSku(item.sku));
}

export function isCartEligibleForMothersDay(
  cartItems: DeliveryValidationItem[] | null | undefined,
): boolean {
  return (
    Array.isArray(cartItems) &&
    cartItems.length > 0 &&
    cartItems.every(isMothersDayEligibleItem)
  );
}

export function canRescheduleDelivery(
  deliveryDate: string,
  currentDate = new Date(),
  timezone = "Asia/Manila",
): boolean {
  if (!isIsoDateString(deliveryDate)) {
    return false;
  }

  const cutoffDate = addDays(deliveryDate, -2);
  const currentLocalDate = getZonedNowParts(timezone, currentDate).date;
  return currentLocalDate <= cutoffDate;
}

export function buildDeliveryTags(
  deliveryDate: string | null | undefined,
  timeSlot: string | null | undefined,
): string[] {
  const dateValue = normalizedString(deliveryDate);
  const timeSlotValue = normalizedString(timeSlot);

  if (!isIsoDateString(dateValue) || !timeSlotValue) {
    return [];
  }

  return [dateValue, timeSlotValue];
}

export function buildDeliveryTag(
  deliveryDate: string | null | undefined,
  timeSlot: string | null | undefined,
): string[] {
  return buildDeliveryTags(deliveryDate, timeSlot);
}

export function replaceExistingDeliveryTags(
  existingTags: string[] | null | undefined,
  newDeliveryTags: string[] | string | null | undefined,
): string[] {
  const nextTags: string[] = [];
  const seenTags = new Set<string>();
  const deliveryTags = Array.isArray(newDeliveryTags)
    ? newDeliveryTags
    : newDeliveryTags
      ? [newDeliveryTags]
      : [];

  for (const rawTag of existingTags ?? []) {
    const tag = normalizedString(rawTag);
    if (!tag || isDeliveryScheduleTag(tag)) {
      continue;
    }

    if (!seenTags.has(tag)) {
      nextTags.push(tag);
      seenTags.add(tag);
    }
  }

  for (const rawTag of deliveryTags) {
    const tag = normalizedString(rawTag);
    if (tag && !seenTags.has(tag)) {
      nextTags.push(tag);
      seenTags.add(tag);
    }
  }

  return nextTags;
}

export function replaceExistingDeliveryTag(
  existingTags: string[] | null | undefined,
  newDeliveryTags: string[] | string | null | undefined,
): string[] {
  return replaceExistingDeliveryTags(existingTags, newDeliveryTags);
}

function toLocalSerial(dateStr: string, minutes: number): number {
  return toDateOrdinal(dateStr) * MINUTES_PER_DAY + minutes;
}

function parseSlotTime(label: string): number | null {
  const match = label.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }

  const baseHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].toUpperCase();

  if (
    !Number.isFinite(baseHour) ||
    !Number.isFinite(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  let hour = baseHour % 12;
  if (meridiem === "PM") {
    hour += 12;
  }

  return hour * MINUTES_PER_HOUR + minute;
}

function getSlotStartSerial(dateStr: string, slotValue: string): number | null {
  const parts = typeof slotValue === "string" ? slotValue.split("-") : [];
  if (parts.length !== 2) {
    return null;
  }

  const startMinutes = parseSlotTime(parts[0]);
  if (startMinutes == null) {
    return null;
  }

  return toLocalSerial(dateStr, startMinutes);
}

function getCutoffMinutes(rules: DeliveryScheduleRules) {
  return Number(rules.cutoffHour) * MINUTES_PER_HOUR;
}

export function getMinSelectableDate(
  rules: DeliveryScheduleRules,
  now = new Date(),
): string {
  const zonedNow = getZonedNowParts(rules.timezone, now);
  const cutoffMinutes = getCutoffMinutes(rules);

  return zonedNow.minutes >= cutoffMinutes
    ? addDays(zonedNow.date, 1)
    : zonedNow.date;
}

export function getMaxSelectableDate(
  rules: DeliveryScheduleRules,
  minDateStr: string,
): string {
  const span = Math.max(1, Number(rules.maxDays) || 1);
  return addDays(minDateStr, span - 1);
}

export function isDateBlocked(
  rules: DeliveryScheduleRules,
  dateStr: string,
): boolean {
  if (isMothersDayRushDate(dateStr)) {
    return false;
  }

  return (
    Array.isArray(rules.disabledDates) && rules.disabledDates.includes(dateStr)
  );
}

export function isSlotBlocked(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): boolean {
  const disabledSlots = rules.disabledSlots?.[dateStr];
  return Array.isArray(disabledSlots) && disabledSlots.includes(slotValue);
}

export function isSlotAtCapacity(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
): boolean {
  const values = rules.slotCapacity?.[dateStr]?.[slotValue];
  if (!values) {
    return false;
  }

  return Number(values.booked) >= Number(values.capacity);
}

export function isDateSelectable(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): boolean {
  if (!isIsoDateString(dateStr)) {
    return false;
  }

  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);

  return (
    dateStr >= minDate && dateStr <= maxDate && !isDateBlocked(rules, dateStr)
  );
}

export function isSlotAvailable(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
  now = new Date(),
): boolean {
  // Keep one shared availability gate so cart, customer account, and server routes
  // all accept and reject the same delivery slot combinations.
  if (!dateStr || !slotValue || !isDateSelectable(rules, dateStr, now)) {
    return false;
  }

  const availableTimeSlots = getAvailableTimeSlots(dateStr, rules);
  if (!availableTimeSlots.some((slot) => slot.value === slotValue)) {
    return false;
  }

  if (
    isSlotBlocked(rules, dateStr, slotValue) ||
    isSlotAtCapacity(rules, dateStr, slotValue)
  ) {
    return false;
  }

  const slotStartSerial = getSlotStartSerial(dateStr, slotValue);
  if (slotStartSerial == null) {
    return false;
  }

  const zonedNow = getZonedNowParts(rules.timezone, now);
  if (dateStr !== zonedNow.date) {
    return true;
  }

  const nowSerial = toLocalSerial(zonedNow.date, zonedNow.minutes);
  const cutoffSerial = toLocalSerial(dateStr, getCutoffMinutes(rules));
  if (nowSerial >= cutoffSerial) {
    return false;
  }

  const latestAllowedOrderSerial =
    slotStartSerial - Number(rules.prepHours) * MINUTES_PER_HOUR;
  return nowSerial < latestAllowedOrderSerial;
}

export function getTodayAvailabilityMessage(
  rules: DeliveryScheduleRules,
  selectedDate: string,
  now = new Date(),
): string {
  if (!selectedDate) {
    return "";
  }

  const zonedNow = getZonedNowParts(rules.timezone, now);
  if (selectedDate !== zonedNow.date) {
    return "";
  }

  return zonedNow.minutes >= getCutoffMinutes(rules)
    ? "Same-day delivery cutoff passed. Choose tomorrow."
    : "";
}

export function getAvailableSlots(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): DeliveryScheduleSlot[] {
  if (!isIsoDateString(dateStr)) {
    return [];
  }

  return getAvailableTimeSlots(dateStr, rules).filter((slot) =>
    isSlotAvailable(rules, dateStr, slot.value, now),
  );
}

export function getUnavailableDatesInWindow(
  rules: DeliveryScheduleRules,
  now = new Date(),
): string[] {
  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);
  const unavailableDates: string[] = [];

  for (
    let currentDate = minDate;
    currentDate <= maxDate;
    currentDate = addDays(currentDate, 1)
  ) {
    const result = validateDeliveryDate(rules, currentDate, now);
    if (!result.ok) {
      unavailableDates.push(currentDate);
    }
  }

  return unavailableDates;
}

export function validateDeliveryDate(
  rules: DeliveryScheduleRules,
  dateStr: string,
  now = new Date(),
): DeliveryDateValidationResult {
  // Return structured date failures so callers can both explain the rejection and
  // keep their surrounding delivery window state in sync with the same rule engine.
  const minDate = getMinSelectableDate(rules, now);
  const maxDate = getMaxSelectableDate(rules, minDate);

  if (!isIsoDateString(dateStr)) {
    return {
      ok: false,
      code: "invalid_date",
      message: "Please select a delivery date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (dateStr < minDate) {
    return {
      ok: false,
      code: "date_before_min",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "Selected delivery date is no longer available. Please choose another date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (dateStr > maxDate) {
    return {
      ok: false,
      code: "date_after_max",
      message: `Selected delivery date is outside the current delivery window. Choose a date between ${minDate} and ${maxDate}.`,
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  if (isDateBlocked(rules, dateStr)) {
    return {
      ok: false,
      code: "date_blocked",
      message:
        "Selected delivery date is unavailable. Please choose another date.",
      minDate,
      maxDate,
      availableSlots: [],
    };
  }

  const availableSlots = getAvailableSlots(rules, dateStr, now);
  if (!availableSlots.length) {
    return {
      ok: false,
      code: "no_slots_available",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "No delivery slots available for this date. Choose another date.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  return {
    ok: true,
    minDate,
    maxDate,
    availableSlots,
    message: "",
  };
}

export function validateDeliverySelection(
  rules: DeliveryScheduleRules,
  dateStr: string,
  slotValue: string,
  now = new Date(),
): DeliverySelectionValidationResult {
  // Run the final slot check only after the date has been normalized so every UI and
  // API surface shares one canonical reason for rejecting a delivery selection.
  const dateValidation = validateDeliveryDate(rules, dateStr, now);
  if (!dateValidation.ok) {
    if (dateValidation.code === "invalid_date") {
      return {
        ok: false,
        code: "invalid_date",
        message: "date must be a valid YYYY-MM-DD string",
        minDate: dateValidation.minDate,
        maxDate: dateValidation.maxDate,
        availableSlots: dateValidation.availableSlots,
      };
    }

    return dateValidation;
  }

  const { minDate, maxDate, availableSlots } = dateValidation;

  if (
    !getAvailableTimeSlots(dateStr, rules).some(
      (slot) => slot.value === slotValue,
    )
  ) {
    return {
      ok: false,
      code: "slot_unknown",
      message:
        "Selected time slot is unavailable. Please choose another time slot.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  if (!availableSlots.length) {
    return {
      ok: false,
      code: "no_slots_available",
      message:
        getTodayAvailabilityMessage(rules, dateStr, now) ||
        "No delivery slots available for this date. Choose another date.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  if (!availableSlots.some((slot) => slot.value === slotValue)) {
    return {
      ok: false,
      code: "slot_unavailable",
      message:
        "Selected time slot is unavailable. Please choose another time slot.",
      minDate,
      maxDate,
      availableSlots,
    };
  }

  return {
    ok: true,
    minDate,
    maxDate,
    availableSlots,
  };
}
