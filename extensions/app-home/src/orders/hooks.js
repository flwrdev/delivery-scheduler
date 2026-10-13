import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import {
  getDeliveryDateValue,
  getDeliveryTimeValue,
} from "../../../../app/lib/order-utils";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const TODAY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Re-runs `reload` every 30 min (60 min on the Today view). A tick that lands
 * while `paused` is queued and fires when the pause lifts. Every new
 * `dataStamp` resets the "Updated" label and drops the queued tick.
 */
export function useSmartRefresh({ isTodayView, paused, dataStamp, reload }) {
  const pausedRef = useRef(paused);
  const queuedRef = useRef(false);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());
  const [, setLabelTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setLabelTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setLastUpdatedAt(Date.now());
    queuedRef.current = false;
  }, [dataStamp]);

  useEffect(() => {
    const ms = isTodayView ? TODAY_INTERVAL_MS : DEFAULT_INTERVAL_MS;
    const id = setInterval(() => {
      if (pausedRef.current) {
        queuedRef.current = true;
        return;
      }
      reloadRef.current();
    }, ms);
    return () => clearInterval(id);
  }, [isTodayView]);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && queuedRef.current) {
      queuedRef.current = false;
      reloadRef.current();
    }
  }, [paused]);

  const ageSec = Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000));
  return ageSec < 60
    ? "Updated just now"
    : ageSec < 3600
      ? `Updated ${Math.floor(ageSec / 60)} min ago`
      : `Updated at ${new Date(lastUpdatedAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}`;
}

function scheduleSnapshot(orders) {
  const byId = new Map();
  for (const o of orders) {
    byId.set(o.id, `${getDeliveryDateValue(o)}|${getDeliveryTimeValue(o)}`);
  }
  return byId;
}

/**
 * Ids that appeared or changed delivery date/slot since the previous load of
 * the same view (`snapshotKey`). They accumulate until dismissed; a new view
 * resets the baseline.
 */
export function useOrdersDiff(orders, snapshotKey) {
  const prevRef = useRef(null);
  const [newIds, setNewIds] = useState(new Set());
  const [changedIds, setChangedIds] = useState(new Set());

  useEffect(() => {
    const byId = scheduleSnapshot(orders);
    const prev = prevRef.current;
    prevRef.current = { key: snapshotKey, byId };

    if (!prev || prev.key !== snapshotKey) {
      setNewIds((s) => (s.size ? new Set() : s));
      setChangedIds((s) => (s.size ? new Set() : s));
      return;
    }

    const added = [];
    const changed = [];
    for (const [id, schedule] of byId) {
      const before = prev.byId.get(id);
      if (before === undefined) added.push(id);
      else if (before !== schedule) changed.push(id);
    }
    if (added.length > 0) setNewIds((s) => new Set([...s, ...added]));
    if (changed.length > 0) setChangedIds((s) => new Set([...s, ...changed]));
  }, [orders, snapshotKey]);

  const dismiss = useCallback(() => {
    setNewIds(new Set());
    setChangedIds(new Set());
  }, []);

  return { newIds, changedIds, dismiss };
}
