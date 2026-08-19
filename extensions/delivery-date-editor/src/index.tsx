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

  // ONE persistent root per activation, and the only write this file ever makes to
  // document.body. Everything below re-renders by replacing the children of this
  // container, never the body — so the container query context (and, on the real
  // surface, the block's scroll position) survives every re-render.
  //
  // s-query-container is here for the customer-account redesign: the order-status
  // page is single-column and inline, so its children can size themselves with
  // `@container (inline-size > Npx) wide, narrow` attribute values instead of
  // guessing at a viewport width. It deliberately does NOT introduce columns —
  // the surface is single-column by design.
  const root = document.createElement('s-query-container');
  document.body.replaceChildren(root);

  // Split-cadence poll. The tick itself is ALWAYS on for the life of the block,
  // but only its cheap half runs unconditionally:
  //
  //   - storage read (local, no network) — every tick, forever. The reschedule
  //     modal and this block live on the SAME customer-account page, and the
  //     block does NOT re-activate when the modal closes, so this read is the
  //     only thing that notices the `delivery-reschedule-sync:` handoff appearing
  //     after the block has already rendered. Stopping it would lose the
  //     optimistic update until a manual refresh — which is the whole reason
  //     this poll exists.
  //   - backend read (network) — only while a fresh handoff is outstanding, and
  //     it stops again the moment that handoff resolves or ages out. The original
  //     code fetched the backend every second for the whole life of the page.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let isPollInFlight = false;
  let hasPendingHandoff = false;

  const startPolling = () => {
    // The handle is kept so arming is idempotent within this activation —
    // repeated calls install at most one interval. (A re-activation gets a
    // fresh closure and its own interval; the target has no teardown hook.)
    if (pollTimer !== null) {
      return;
    }

    pollTimer = setInterval(() => {
      void pollOnce();
    }, RESCHEDULE_SYNC_POLL_MS);
  };

  const pollOnce = async () => {
    // Skip the tick outright if the previous one has not settled: at a 1s period a
    // slow backend would otherwise stack overlapping fetches on top of each other.
    if (isPollInFlight) {
      return;
    }

    isPollInFlight = true;
    try {
      await syncPendingRescheduleFromStorage();

      if (hasPendingHandoff) {
        await syncLatestDelivery();
      }
    } finally {
      isPollInFlight = false;
    }
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
      // The handoff resolved — stop hitting the backend. The storage half of the
      // tick keeps running, ready for the next handoff.
      hasPendingHandoff = false;
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
      root.replaceChildren();
      return;
    }

    const rescheduleStatus =
      pendingSync?.status ?? latestDelivery?.status ?? storedRescheduleStatus;

    const section = document.createElement('s-section');
    const orderLabel = order?.name ? ` · ${order.name}` : '';
    section.setAttribute('heading', `Delivery Schedule${orderLabel}`);

    // One design-token gap on the parent spaces every labelled value, tightened
    // a step on a narrow container (the inline order-status card on a phone).
    const content = createElement('s-stack', {
      direction: 'block',
      gap: '@container (inline-size > 400px) base, small-300',
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
    root.replaceChildren(section);
  };

  const syncPendingRescheduleFromStorage = async () => {
    const nextPendingSync = await readPendingRescheduleSync(
      api.storage,
      state.order?.id ?? null,
    );

    // Gate the backend half of the tick. `readPendingRescheduleSync` already
    // deletes a marker older than RESCHEDULE_SYNC_MAX_AGE_MS and answers null, so
    // the freshness cap doubles as a stop condition: the fetches end right after
    // that final clear instead of running for the life of the page.
    hasPendingHandoff = nextPendingSync !== null;

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
  startPolling();

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
  // Typography and color are the design system's job — never pin a literal
  // color here: a hard-coded black reads as invisible text on a dark
  // customer-account theme. `color="subdued"` on the label and the default
  // tone on the value give the visual hierarchy while
  // following the surface's own palette.
  const group = createElement('s-stack', {
    direction: 'block',
    gap: 'small-100',
  });

  const labelText = createElement('s-text', { color: 'subdued' });
  labelText.textContent = label;

  const valueText = document.createElement('s-text');
  valueText.textContent = value;
  // No design-system equivalent, so this is the file's only inline style.
  // Applied to every value; it matters for the free-text card message, which
  // can carry a long unbroken string that would otherwise widen the block past
  // the card on a narrow container.
  valueText.setAttribute('style', 'overflow-wrap:anywhere');

  group.append(labelText, valueText);
  return group;
}
