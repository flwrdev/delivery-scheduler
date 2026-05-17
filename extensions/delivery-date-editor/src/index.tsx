export default async function renderOrderStatusBlock() {
  const api = (globalThis as unknown as {
    shopify: CustomerAccountOrderStatusApi;
  }).shopify as CustomerAccountOrderStatusApi;

  // Keep both the host-provided order snapshot and our own refresh sources because
  // the customer-account page can lag behind immediately after a reschedule save.
  const state = {
    metafields: getSubscribableValue(api.appMetafields) ?? [],
    attributes: getSubscribableValue(api.attributes) ?? [],
    order: getSubscribableValue(api.order),
    pendingSync: null as PendingRescheduleSync | null,
    latestDelivery: null as OrderDeliverySnapshot | null,
  };

  const render = () => {
    const metafields = state.metafields;
    const attributes = state.attributes;
    const order = state.order;
    const latestDelivery = state.latestDelivery;

    const attrs: Record<string, string> = {};
    for (const attr of attributes) {
      attrs[attr.key] = attr.value;
    }

    const metaDate = getMetafieldValue(metafields, 'custom', 'date');
    const metaTime = getMetafieldValue(metafields, 'custom', 'time_slot');
    const storedRescheduleStatus = getMetafieldValue(
      metafields,
      '$app',
      'reschedule_status',
    );

    let pendingSync = state.pendingSync;
    // Clear the optimistic handoff once either the direct server fetch or Shopify's
    // host payload confirms the saved delivery values.
    if (
      order?.id &&
      pendingSync &&
      doesDeliveryMatchPendingSync(
        pendingSync,
        latestDelivery ?? {
          date: metaDate,
          timeSlot: metaTime,
          status: storedRescheduleStatus,
        },
      )
    ) {
      state.pendingSync = null;
      pendingSync = null;
      void clearPendingRescheduleSync(api.storage, order.id);
    }

    // Prefer the optimistic handoff and the direct server read over the host snapshot
    // so the block reflects a successful reschedule without a full page reload.
    const deliveryDate =
      pendingSync?.date ?? latestDelivery?.date ?? metaDate ?? attrs['Delivery Date'] ?? null;
    const deliveryTime =
      pendingSync?.timeSlot ??
      latestDelivery?.timeSlot ??
      metaTime ??
      attrs['Delivery Time'] ??
      null;
    const cardMessage = attrs['Card Message'] ?? null;

    if (!deliveryDate && !deliveryTime) {
      document.body.replaceChildren();
      return;
    }

    const rescheduleStatus =
      pendingSync?.status ?? latestDelivery?.status ?? storedRescheduleStatus;

    const section = document.createElement('s-section');
    const orderLabel = order?.name ? ` · ${order.name}` : '';
    section.setAttribute('heading', `Delivery Schedule${orderLabel}`);

    const content = createElement('s-stack', {
      direction: 'block',
    });

    if (deliveryDate) {
      content.append(createLabeledValue('Date', deliveryDate));
    }

    if (deliveryTime) {
      content.append(createLabeledValue('Time slot', deliveryTime));
    }

    if (cardMessage) {
      content.append(createLabeledValue('Card message', cardMessage));
    }

    if (rescheduleStatus === 'confirmed') {
      const badge = createElement('s-badge', { tone: 'neutral' });
      const formattedDate = deliveryDate ? ` to ${formatDisplayDate(deliveryDate)}` : '';
      badge.textContent = `Rescheduled${formattedDate}`;
      content.append(badge);
    }

    section.append(content);
    document.body.replaceChildren(section);
  };

  const syncPendingRescheduleFromStorage = async () => {
    const nextPendingSync = await readPendingRescheduleSync(
      api.storage,
      state.order?.id ?? null,
    );

    if (isSamePendingRescheduleSync(state.pendingSync, nextPendingSync)) {
      return;
    }

    state.pendingSync = nextPendingSync;
    render();
  };

  const syncLatestDelivery = async () => {
    // Poll the app backend because closing the reschedule modal does not reliably
    // cause Shopify's customer-account shell to refetch order delivery metafields.
    const nextDelivery = await fetchLatestOrderDelivery(api, state.order?.id ?? null);

    if (isSameOrderDeliverySnapshot(state.latestDelivery, nextDelivery)) {
      return;
    }

    state.latestDelivery = nextDelivery;
    render();
  };

  subscribeToSubscribable(api.appMetafields, (value) => {
    state.metafields = value ?? [];
    render();
  });
  subscribeToSubscribable(api.attributes, (value) => {
    state.attributes = value ?? [];
    render();
  });
  subscribeToSubscribable(api.order, (value) => {
    state.order = value;
    void syncPendingRescheduleFromStorage();
    void syncLatestDelivery();
    render();
  });

  await syncPendingRescheduleFromStorage();
  await syncLatestDelivery();
  setInterval(() => {
    void syncPendingRescheduleFromStorage();
    void syncLatestDelivery();
  }, RESCHEDULE_SYNC_POLL_MS);

  render();
}

const APP_BASE_URL = 'https://delivery-scheduler-299861709433.us-central1.run.app';
const ORDER_DELIVERY_URL = `${APP_BASE_URL}/public/customer-account/order-delivery`;
const RESCHEDULE_SYNC_KEY_PREFIX = 'delivery-reschedule-sync:';
const RESCHEDULE_SYNC_MAX_AGE_MS = 15 * 60 * 1000;
const RESCHEDULE_SYNC_POLL_MS = 1000;

type PendingRescheduleSync = {
  date: string;
  timeSlot: string;
  status: 'confirmed';
  updatedAt: number;
};

type OrderDeliverySnapshot = {
  date: string | null;
  timeSlot: string | null;
  status: string | null;
};

type CustomerAccountOrderStatusApi = {
  appMetafields: ExtensionSubscribable<
    Array<{ metafield: { namespace: string; key: string; value?: unknown } }>
  >;
  attributes: ExtensionSubscribable<Array<{ key: string; value: string }> | undefined>;
  order: ExtensionSubscribable<{ id?: string | null; name?: string | null } | undefined>;
  sessionToken: {
    get: () => Promise<string>;
  };
  storage: ExtensionStorage;
};

type ExtensionSubscribable<T> = {
  value?: T;
  current?: T;
  subscribe?: (subscriber: (value: T) => void) => (() => void) | void;
};

type ExtensionStorage = {
  read: <T = unknown>(key: string) => Promise<T | null>;
  delete: (key: string) => Promise<void>;
};

const CONTACT_BLOCK_BODY_TEXT = {
  fontFamily: 'Nunito, sans-serif',
  fontSize: '14px',
  fontWeight: '400',
  lineHeight: '21px',
  color: 'rgb(0, 0, 0)',
};

function getMetafieldValue(
  metafields: Array<{ metafield: { namespace: string; key: string; value?: unknown } }>,
  namespace: string,
  key: string,
): string | null {
  const metafield = metafields.find(
    (entry) =>
      entry.metafield.namespace === namespace && entry.metafield.key === key,
  );
  return metafield?.metafield.value?.toString() ?? null;
}

function getSubscribableValue<T>(subscribable: ExtensionSubscribable<T>): T | undefined {
  return subscribable.current ?? subscribable.value;
}

function subscribeToSubscribable<T>(
  subscribable: ExtensionSubscribable<T>,
  onValue: (value: T) => void,
) {
  subscribable.subscribe?.((value) => {
    onValue(value);
  });
}

async function fetchLatestOrderDelivery(
  api: CustomerAccountOrderStatusApi,
  orderId: string | null | undefined,
) {
  if (!orderId) {
    return null;
  }

  try {
    // Reuse the customer-account session token so the backend can validate both the
    // signed-in customer and the specific order before returning fresh delivery data.
    const sessionToken = await api.sessionToken.get();
    const requestBody = new URLSearchParams({ orderId, sessionToken });

    const response = await fetch(ORDER_DELIVERY_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: requestBody,
    });

    const responseBody = (await response.json().catch(() => ({}))) as {
      delivery?: OrderDeliverySnapshot;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(responseBody.error ?? `Order delivery request failed (${response.status})`);
    }

    if (!isOrderDeliverySnapshot(responseBody.delivery)) {
      return null;
    }

    return responseBody.delivery;
  } catch (error) {
    console.warn('Failed to fetch latest order delivery:', error);
    return null;
  }
}

async function readPendingRescheduleSync(
  storage: ExtensionStorage,
  orderId: string | null | undefined,
) {
  if (!orderId) {
    return null;
  }

  try {
    for (const key of getPendingRescheduleSyncKeys(orderId)) {
      const value = await storage.read<unknown>(key);
      if (value == null) {
        continue;
      }

      if (!isPendingRescheduleSync(value)) {
        await storage.delete(key);
        continue;
      }

      if (Date.now() - value.updatedAt > RESCHEDULE_SYNC_MAX_AGE_MS) {
        await storage.delete(key);
        continue;
      }

      return value;
    }

    return null;
  } catch (error) {
    console.warn('Failed to read pending reschedule sync:', error);
    return null;
  }
}

async function clearPendingRescheduleSync(storage: ExtensionStorage, orderId: string) {
  try {
    await Promise.all(
      getPendingRescheduleSyncKeys(orderId).map((key) => storage.delete(key)),
    );
  } catch (error) {
    console.warn('Failed to clear pending reschedule sync:', error);
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

function isPendingRescheduleSync(value: unknown): value is PendingRescheduleSync {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.date === 'string' &&
    typeof candidate.timeSlot === 'string' &&
    candidate.status === 'confirmed' &&
    typeof candidate.updatedAt === 'number'
  );
}

function isOrderDeliverySnapshot(value: unknown): value is OrderDeliverySnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.date === null || typeof candidate.date === 'string') &&
    (candidate.timeSlot === null || typeof candidate.timeSlot === 'string') &&
    (candidate.status === null || typeof candidate.status === 'string')
  );
}

function isSamePendingRescheduleSync(
  left: PendingRescheduleSync | null,
  right: PendingRescheduleSync | null,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.date === right.date &&
    left.timeSlot === right.timeSlot &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt
  );
}

function isSameOrderDeliverySnapshot(
  left: OrderDeliverySnapshot | null,
  right: OrderDeliverySnapshot | null,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.date === right.date &&
    left.timeSlot === right.timeSlot &&
    left.status === right.status
  );
}

function doesDeliveryMatchPendingSync(
  pendingSync: PendingRescheduleSync,
  delivery: OrderDeliverySnapshot,
) {
  return (
    delivery.date === pendingSync.date &&
    delivery.timeSlot === pendingSync.timeSlot &&
    delivery.status === pendingSync.status
  );
}

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

function createElement(
  tagName: string,
  attributes: Record<string, string>,
) {
  const element = document.createElement(tagName) as HTMLElement;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

function createLabeledValue(label: string, value: string) {
  const group = createElement('s-stack', {
    direction: 'block',
  });
  setInlineStyle(group, {
    display: 'block',
    margin: '0 0 16px',
  });

  const labelText = document.createElement('s-text');
  labelText.textContent = label;
  applyContactBlockBodyStyle(labelText);

  const valueText = document.createElement('s-text');
  valueText.textContent = value;
  applyContactBlockBodyStyle(valueText);
  appendInlineStyle(valueText, {
    marginTop: '8px',
  });

  group.append(labelText, valueText);
  return group;
}

function applyContactBlockBodyStyle(element: HTMLElement) {
  setInlineStyle(element, {
    display: 'block',
    margin: '0',
    fontFamily: CONTACT_BLOCK_BODY_TEXT.fontFamily,
    fontSize: CONTACT_BLOCK_BODY_TEXT.fontSize,
    fontWeight: CONTACT_BLOCK_BODY_TEXT.fontWeight,
    lineHeight: CONTACT_BLOCK_BODY_TEXT.lineHeight,
    color: CONTACT_BLOCK_BODY_TEXT.color,
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
  });
}

function setInlineStyle(
  element: HTMLElement,
  styles: Record<string, string>,
) {
  element.setAttribute('style', inlineStyle(styles));
}

function appendInlineStyle(
  element: HTMLElement,
  styles: Record<string, string>,
) {
  const currentStyle = element.getAttribute('style');
  const nextStyle = inlineStyle(styles);

  element.setAttribute(
    'style',
    currentStyle ? `${currentStyle};${nextStyle}` : nextStyle,
  );
}

function inlineStyle(styles: Record<string, string>) {
  return Object.entries(styles)
    .map(([name, value]) => `${toKebabCase(name)}:${value}`)
    .join(';');
}

function toKebabCase(value: string) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
