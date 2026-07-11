import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  cloneDeliveryScheduleRules,
  getMaxSelectableDate,
  getMinSelectableDate,
  getUnavailableDatesInWindow,
  validateDeliveryDate,
  validateDeliverySelection,
  type DeliveryScheduleRules,
  type DeliveryScheduleSlot,
  type DeliverySelectionValidationCode,
} from '../../../app/lib/delivery-availability';

export default async function renderRescheduleModal() {
  const shopifyApi = getShopifyApi();
  const fallbackRules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);
  const minDate = getMinSelectableDate(fallbackRules);
  const state = {
    date: '',
    timeSlot: '',
    dateError: '',
    timeError: '',
    availabilityMessage: '',
    isLoadingRules: true,
    isSubmitting: false,
    submitError: '',
    confirmedDate: '',
    confirmedSlot: '',
    rules: fallbackRules,
    availableSlots: [] as DeliveryScheduleSlot[],
    minDate,
    maxDate: getMaxSelectableDate(fallbackRules, minDate),
    disallowDates: '' as string,
  };

  const rerender = () => {
    document.body.replaceChildren(buildAction(state, shopifyApi, rerender));
  };

  applyAvailabilityState(state);
  void loadScheduleRules(state, shopifyApi, rerender);
  rerender();
}

const APP_BASE_URL = 'https://delivery-scheduler-299861709433.us-central1.run.app';
const SCHEDULE_RULES_URL = `${APP_BASE_URL}/public/customer-account/schedule-rules`;
const RESCHEDULE_URL = `${APP_BASE_URL}/public/customer-account/reschedule`;
const RESCHEDULE_SYNC_KEY_PREFIX = 'delivery-reschedule-sync:';

function formatDisplayDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

type RescheduleState = {
  date: string;
  timeSlot: string;
  dateError: string;
  timeError: string;
  availabilityMessage: string;
  isLoadingRules: boolean;
  isSubmitting: boolean;
  submitError: string;
  confirmedDate: string;
  confirmedSlot: string;
  rules: DeliveryScheduleRules;
  availableSlots: DeliveryScheduleSlot[];
  minDate: string;
  maxDate: string;
  disallowDates: string;
};

type ShopifyActionApi = {
  close: () => void;
  orderId: string;
  storage: {
    write: (key: string, value: unknown) => Promise<void>;
  };
  sessionToken: {
    get: () => Promise<string>;
  };
};

type PendingRescheduleSync = {
  date: string;
  timeSlot: string;
  status: 'confirmed';
  updatedAt: number;
};

function getShopifyApi() {
  return (globalThis as unknown as { shopify: ShopifyActionApi }).shopify;
}

function buildAction(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
) {
  if (state.confirmedDate) {
    return buildSuccessAction(state, shopifyApi);
  }

  const action = createElement('s-customer-account-action', {
    heading: 'Reschedule Delivery',
  });

  const stack = createElement('s-stack', {
    direction: 'block',
    gap: 'base',
  });

  // The one-online-reschedule policy rides inside the intro sentence
  // (merchant decision 2026-07-12: no extra line — avoid vertical clutter).
  // The backend enforces the limit via the `resched` tag; this only sets
  // the expectation before the customer submits.
  const intro = document.createElement('s-text');
  intro.textContent = state.isLoadingRules
    ? 'Loading available delivery dates and time slots.'
    : 'Select a new delivery date and time slot. You can reschedule your delivery only once, so please choose carefully.';
  stack.append(intro);

  if (state.submitError) {
    const banner = createElement('s-banner', { tone: 'critical' });
    banner.textContent = state.submitError;
    stack.append(banner);
  }

  if (state.availabilityMessage) {
    const banner = createElement('s-banner', { tone: 'critical' });
    banner.textContent = state.availabilityMessage;
    stack.append(banner);
  }

  const dateField = createElement('s-date-field', {
    label: 'New delivery date',
    allow: `${state.minDate}--${state.maxDate}`,
  });
  setOptionalAttribute(dateField, 'disallow', state.disallowDates);
  if (state.isLoadingRules || state.isSubmitting) {
    dateField.setAttribute('disabled', '');
  }
  setOptionalAttribute(dateField, 'error', state.dateError);
  setElementValue(dateField, state.date);
  dateField.addEventListener('change', (event) => {
    state.date = getEventValue(event);
    state.dateError = '';
    state.timeError = '';
    state.submitError = '';
    applyAvailabilityState(state);
    rerender();
  });
  stack.append(dateField);

  const select = createElement('s-select', {
    label: 'Time slot',
  });
  if (
    state.isLoadingRules ||
    state.isSubmitting ||
    !state.date ||
    !state.availableSlots.length
  ) {
    select.setAttribute('disabled', '');
  }
  setOptionalAttribute(select, 'error', state.timeError);
  select.addEventListener('change', (event) => {
    state.timeSlot = getEventValue(event);
    state.timeError = '';
    state.submitError = '';
    rerender();
  });
  select.append(createOption('', getTimeSlotPlaceholder(state)));
  for (const option of state.availableSlots) {
    select.append(createOption(option.value, option.display));
  }
  setElementValue(select, state.timeSlot);
  stack.append(select);

  const confirmButton = createElement('s-button', {
    slot: 'primary-action',
  });
  if (state.isSubmitting || state.isLoadingRules) {
    confirmButton.setAttribute('loading', '');
    confirmButton.setAttribute('disabled', '');
  }
  confirmButton.textContent = 'Confirm';
  confirmButton.addEventListener('click', async () => {
    await submitReschedule(state, shopifyApi, rerender);
  });

  const cancelButton = createElement('s-button', {
    slot: 'secondary-actions',
  });
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    shopifyApi.close();
  });

  action.append(stack, confirmButton, cancelButton);
  return action;
}

function buildSuccessAction(state: RescheduleState, shopifyApi: ShopifyActionApi) {
  const action = createElement('s-customer-account-action', {
    heading: 'Delivery Rescheduled',
  });
  const stack = createElement('s-stack', {
    direction: 'block',
    gap: 'base',
  });
  const banner = createElement('s-banner', { tone: 'success' });
  const slotLabel =
    state.rules.slots.find((option) => option.value === state.confirmedSlot)?.display ??
    state.confirmedSlot;
  banner.textContent = `Your delivery has been rescheduled to ${formatDisplayDate(state.confirmedDate)} (${slotLabel}).`;
  stack.append(banner);

  const doneButton = createElement('s-button', {
    slot: 'primary-action',
  });
  doneButton.textContent = 'Done';
  doneButton.addEventListener('click', () => {
    shopifyApi.close();
  });

  action.append(stack, doneButton);
  return action;
}

async function submitReschedule(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
) {
  let hasError = false;

  // Keep the local form checks aligned with the server rules so we can block empty
  // submissions immediately instead of always waiting for a round trip to fail.
  if (!state.date) {
    state.dateError = 'Please select a delivery date.';
    hasError = true;
  } else {
    state.dateError = '';
  }

  if (!state.timeSlot) {
    state.timeError = 'Please select a time slot.';
    hasError = true;
  } else {
    state.timeError = '';
  }

  if (hasError) {
    rerender();
    return;
  }

  const selectionValidation = validateDeliverySelection(
    state.rules,
    state.date,
    state.timeSlot,
  );
  if (!selectionValidation.ok) {
    applyRuleValidationFailure(state, {
      code: selectionValidation.code,
      message: selectionValidation.message,
      availableSlots: selectionValidation.availableSlots,
      minDate: selectionValidation.minDate,
      maxDate: selectionValidation.maxDate,
    });
    rerender();
    return;
  }

  state.isSubmitting = true;
  state.submitError = '';
  rerender();

  try {
    // Send the write through the app backend so the same auth, ownership, and
    // delivery-rule validation is enforced for every customer-account submission.
    const sessionToken = await shopifyApi.sessionToken.get();

    const requestBody = new URLSearchParams({
      orderId: shopifyApi.orderId,
      date: state.date,
      timeSlot: state.timeSlot,
      sessionToken,
    });

    const response = await fetch(RESCHEDULE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: requestBody,
    });

    const responseBody = (await response.json().catch(() => ({}))) as RescheduleErrorBody;
    if (!response.ok) {
      if (response.status === 422) {
        applyRuleValidationFailure(state, {
          code: responseBody.code,
          message: responseBody.error ?? `Request failed (${response.status})`,
          availableSlots: parseAvailableSlots(responseBody.availableSlots),
          minDate: responseBody.minDate,
          maxDate: responseBody.maxDate,
        });
      } else {
        state.submitError = responseBody.error ?? `Request failed (${response.status})`;
      }
      return;
    }

    // Persist an optimistic handoff for the order-status block so it can reflect the
    // saved delivery selection before Shopify refreshes its own order payload.
    await writePendingRescheduleSync(shopifyApi, {
      date: state.date,
      timeSlot: state.timeSlot,
      status: 'confirmed',
      updatedAt: Date.now(),
    });

    // Move the modal into success state using the values that just saved instead of
    // waiting for the surrounding customer-account page to re-read the order.
    state.confirmedDate = state.date;
    state.confirmedSlot = state.timeSlot;
  } catch (error) {
    state.submitError =
      (error as Error).message ?? 'Something went wrong. Please try again.';
  } finally {
    state.isSubmitting = false;
    rerender();
  }
}

async function loadScheduleRules(
  state: RescheduleState,
  shopifyApi: ShopifyActionApi,
  rerender: () => void,
) {
  try {
    // Load availability from the backend so the reschedule modal stays aligned with
    // the same capacity and blackout rules used by the rest of the storefront flow.
    state.rules = await fetchScheduleRules(shopifyApi);
  } catch (error) {
    console.warn('Delivery rules fetch failed:', error);
    state.rules = cloneDeliveryScheduleRules(DEFAULT_DELIVERY_SCHEDULE_RULES);
  } finally {
    state.isLoadingRules = false;
    applyAvailabilityState(state);
    rerender();
  }
}

async function fetchScheduleRules(
  shopifyApi: ShopifyActionApi,
): Promise<DeliveryScheduleRules> {
  const sessionToken = await shopifyApi.sessionToken.get();
  const requestBody = new URLSearchParams({ sessionToken });

  const response = await fetch(SCHEDULE_RULES_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: requestBody,
  });

  const responseBody = (await response.json().catch(() => ({}))) as {
    error?: string;
    rules?: unknown;
  };

  if (!response.ok) {
    throw new Error(responseBody.error ?? `Rules request failed (${response.status})`);
  }

  if (!isDeliveryScheduleRules(responseBody.rules)) {
    throw new Error('Invalid schedule rules response');
  }

  return cloneDeliveryScheduleRules(responseBody.rules);
}

async function writePendingRescheduleSync(
  shopifyApi: ShopifyActionApi,
  value: PendingRescheduleSync,
) {
  try {
    await Promise.all(
      getPendingRescheduleSyncKeys(shopifyApi.orderId).map((key) =>
        shopifyApi.storage.write(key, value),
      ),
    );
  } catch (error) {
    console.warn('Failed to persist pending reschedule sync:', error);
  }
}

function getPendingRescheduleSyncKeys(orderId: string) {
  const numericOrderId = extractNumericOrderId(orderId);
  const keys = new Set([`${RESCHEDULE_SYNC_KEY_PREFIX}${orderId}`]);

  if (numericOrderId) {
    keys.add(`${RESCHEDULE_SYNC_KEY_PREFIX}${numericOrderId}`);
    keys.add(`${RESCHEDULE_SYNC_KEY_PREFIX}gid://shopify/Order/${numericOrderId}`);
  }

  return [...keys];
}

function extractNumericOrderId(orderId: string) {
  const match = orderId.match(/(\d+)$/);
  return match ? match[1] : null;
}

function applyAvailabilityState(state: RescheduleState) {
  state.minDate = getMinSelectableDate(state.rules);
  state.maxDate = getMaxSelectableDate(state.rules, state.minDate);
  state.disallowDates = getUnavailableDatesInWindow(state.rules).join(',');
  state.availabilityMessage = '';

  if (!state.date) {
    state.availableSlots = [];
    state.timeSlot = '';
    return;
  }

  const dateValidation = validateDeliveryDate(state.rules, state.date);
  if (dateValidation.ok) {
    state.availableSlots = dateValidation.availableSlots;
    if (!dateValidation.availableSlots.some((slot) => slot.value === state.timeSlot)) {
      state.timeSlot = '';
    }
    return;
  }

  state.availableSlots = dateValidation.availableSlots;
  state.timeSlot = '';
  state.availabilityMessage = dateValidation.message;

  if (dateValidation.code !== 'no_slots_available') {
    state.date = '';
  }
}

function applyRuleValidationFailure(
  state: RescheduleState,
  failure: {
    code?: DeliverySelectionValidationCode;
    message: string;
    availableSlots?: DeliveryScheduleSlot[];
    minDate?: string;
    maxDate?: string;
  },
) {
  if (failure.minDate) {
    state.minDate = failure.minDate;
  }
  if (failure.maxDate) {
    state.maxDate = failure.maxDate;
  }

  state.submitError = '';
  state.availabilityMessage = failure.message;

  if (failure.code === 'slot_unknown' || failure.code === 'slot_unavailable') {
    state.availableSlots = failure.availableSlots ?? state.availableSlots;
    state.timeSlot = '';
    return;
  }

  if (failure.code === 'no_slots_available') {
    state.availableSlots = [];
    state.timeSlot = '';
    return;
  }

  state.availableSlots = [];
  state.date = '';
  state.timeSlot = '';
}

function getTimeSlotPlaceholder(state: RescheduleState) {
  if (state.isLoadingRules) {
    return 'Loading time slots...';
  }

  if (!state.date) {
    return 'Select a delivery date first';
  }

  if (!state.availableSlots.length) {
    return 'No time slots available';
  }

  return 'Select a time slot';
}

type RescheduleErrorBody = {
  error?: string;
  code?: DeliverySelectionValidationCode;
  minDate?: string;
  maxDate?: string;
  availableSlots?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeliveryScheduleRules(value: unknown): value is DeliveryScheduleRules {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.timezone === 'string' &&
    typeof value.cutoffHour === 'number' &&
    typeof value.prepHours === 'number' &&
    typeof value.maxDays === 'number' &&
    Array.isArray(value.slots) &&
    Array.isArray(value.disabledDates) &&
    isRecord(value.disabledSlots) &&
    isRecord(value.slotCapacity)
  );
}

function parseAvailableSlots(value: unknown): DeliveryScheduleSlot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((slot) => {
    if (!isRecord(slot)) {
      return [];
    }

    if (typeof slot.display !== 'string' || typeof slot.value !== 'string') {
      return [];
    }

    return [{ display: slot.display, value: slot.value }];
  });
}

function createElement(tagName: string, attributes: Record<string, string>) {
  const element = document.createElement(tagName) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function createOption(value: string, label: string) {
  const option = createElement('s-option', { value });
  option.textContent = label;
  return option;
}

function setOptionalAttribute(element: HTMLElement, name: string, value: string) {
  if (value) {
    element.setAttribute(name, value);
  }
}

function setElementValue(element: HTMLElement, value: string) {
  const control = element as HTMLElement & { value?: string };

  control.value = value;

  if (value) {
    element.setAttribute('value', value);
    return;
  }

  element.removeAttribute('value');
}

function getEventValue(event: Event) {
  const target =
    (event.currentTarget as { value?: string } | null) ??
    (event.target as { value?: string } | null);

  return (target?.value ?? '').toString();
}
