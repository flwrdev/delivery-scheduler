import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import { computeDateRefs } from "../../../../app/lib/date-refs";
import {
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getMeaningfulTags,
  normalizeDateToISO,
  tagDisplayLabel,
} from "../../../../app/lib/order-utils";
import {
  DEFAULT_SORT,
  buildOrdersTabDefs,
  collectSelectedTags,
  computeOrderKpis,
  computeTabCounts,
  findHiddenSearchMatches,
  selectDisplayedOrders,
} from "../../../../app/lib/orders-view";
import { loadEmailReplies, markRepliesSeen } from "../email-client";
import { BULK_MODAL_ID, BulkModal } from "../orders/BulkModal";
import { ReplyModal, ThreadModal } from "../orders/EmailModals";
import { NotificationsBell } from "../orders/NotificationsBell";
import { useOrdersDiff, useSmartRefresh } from "../orders/hooks";
import { loadOrders, loadRescheduleRules, markReschedulesSeen } from "../orders/orders-api";
import { RecentReschedules } from "../orders/RecentReschedules";
import { RESCHEDULE_MODAL_ID, RescheduleModal } from "../orders/RescheduleModal";
import { OrdersTable } from "../orders/OrdersTable";
import { useBulkActions } from "../orders/use-bulk-actions";

const INFO_MODAL_ID = "orders-info-modal";
const SEARCH_DEBOUNCE_MS = 300;

function queryOf(url) {
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

function Kpi({ label, value, tone, children }) {
  return (
    <s-box padding="base" background="base" borderRadius="base" border="base">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{tone ? <s-text tone={tone}>{value}</s-text> : value}</s-heading>
        {children}
      </s-stack>
    </s-box>
  );
}

export default function OrdersPage() {
  const location = useLocation();
  const searchParams = useMemo(() => queryOf(location.url), [location.url]);
  const queryKey = searchParams.toString();

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(
    async ({ background = false } = {}) => {
      const requestId = ++requestRef.current;
      if (!background) setLoading(true);
      try {
        const next = await loadOrders(queryOf(location.url));
        if (requestId !== requestRef.current) return;
        setData(next);
        setLoadError(null);
        setErrorDismissed(false);
      } catch (error) {
        console.error("Failed to load orders:", error);
        if (requestId === requestRef.current) {
          setLoadError(error instanceof Error ? error.message : "Orders could not be loaded.");
        }
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [location.url],
  );

  useEffect(() => {
    reload();
  }, [queryKey]);

  const navigate = useCallback(
    (params, replace = true) => {
      const qs = params.toString();
      location.route(qs ? `/?${qs}` : "/", replace);
    },
    [location],
  );

  const orders = data?.orders ?? [];
  const pageInfo = data?.pageInfo ?? null;
  const tabParam = data?.tabParam ?? "all";
  const searchParam = data?.searchParam ?? "";
  const timeWindowParam = data?.timeWindowParam ?? "";
  const sortParam = data?.sortParam ?? DEFAULT_SORT;
  const deliveryDateFilter = data?.deliveryDateParam || "";
  const todayISO = data?.todayISO ?? "";

  const dateRefs = useMemo(() => computeDateRefs(todayISO), [todayISO]);

  const displayedOrders = useMemo(
    () =>
      selectDisplayedOrders(
        orders,
        { tabParam, deliveryDateFilter, timeWindowParam, sortParam },
        dateRefs,
      ),
    [orders, tabParam, dateRefs, sortParam, deliveryDateFilter, timeWindowParam],
  );

  // ── Selection ───────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState([]);
  const clearSelection = useCallback(() => setSelectedIds([]), []);
  const removeSelected = useCallback(
    (ids) => setSelectedIds((current) => current.filter((id) => !ids.includes(id))),
    [],
  );
  useEffect(() => {
    const visible = new Set(displayedOrders.map((o) => o.id));
    setSelectedIds((current) => {
      const kept = current.filter((id) => visible.has(id));
      return kept.length === current.length ? current : kept;
    });
  }, [displayedOrders]);
  useEffect(() => {
    clearSelection();
  }, [tabParam, clearSelection]);
  const toggleSelected = useCallback((id) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);
  const toggleAll = useCallback(
    (select) => setSelectedIds(select ? displayedOrders.map((o) => o.id) : []),
    [displayedOrders],
  );

  // ── Modals ──────────────────────────────────────────────────────────────────
  const bulkModalRef = useRef(null);
  const rescheduleModalRef = useRef(null);
  const infoModalRef = useRef(null);
  const hideModals = useCallback(() => {
    bulkModalRef.current?.hideOverlay?.();
    rescheduleModalRef.current?.hideOverlay?.();
  }, []);

  const bulk = useBulkActions({
    selectedIds,
    clearSelection,
    removeSelected,
    reload,
    hideModals,
  });

  const [info, setInfo] = useState(null);
  const [rescheduleOpenCount, setRescheduleOpenCount] = useState(0);
  const [rescheduleRules, setRescheduleRules] = useState(null);
  const [rescheduleRulesLoading, setRescheduleRulesLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const openBulkModal = (name) => {
    bulk.openModal(name);
    setModalOpen(true);
  };

  const openReschedule = () => {
    bulk.openModal("reschedule");
    setModalOpen(true);
    setRescheduleOpenCount((n) => n + 1);
    setRescheduleRules(null);
    setRescheduleRulesLoading(true);
    loadRescheduleRules()
      .then(setRescheduleRules)
      .catch((error) => console.error("Failed to load delivery settings:", error))
      .finally(() => setRescheduleRulesLoading(false));
  };

  const onModalHide = useCallback(() => {
    setModalOpen(false);
    bulk.resetForms();
  }, [bulk.resetForms]);

  const rescheduleTargets = useMemo(() => {
    if (bulk.activeModal !== "reschedule") return [];
    const found = [];
    for (const id of selectedIds) {
      const order = orders.find((o) => o.id === id);
      if (!order) continue;
      const currentDate = getDeliveryDateValue(order);
      const currentSlot = getDeliveryTimeValue(order);
      found.push({
        id,
        name: order.name,
        currentDate: currentDate === "—" ? null : currentDate,
        currentSlot: currentSlot === "—" ? null : currentSlot,
      });
    }
    return found;
  }, [bulk.activeModal, selectedIds, orders]);

  const lastResult = bulk.lastActionResult;
  const rescheduleServerCapacity =
    lastResult?.action === "reschedule" &&
    lastResult.code === "capacity_override_required" &&
    lastResult.capacity
      ? lastResult.capacity
      : null;

  // ── Customer emails ─────────────────────────────────────────────────────────
  const [inbox, setInbox] = useState({ loading: true, error: null, replies: [] });
  const inboxRequestRef = useRef(0);
  const inboxLoadedAtRef = useRef(0);
  const reloadInbox = useCallback(async (minAgeMs = 0) => {
    if (Date.now() - inboxLoadedAtRef.current < minAgeMs) return;
    inboxLoadedAtRef.current = Date.now();
    const requestId = ++inboxRequestRef.current;
    setInbox((current) => ({ ...current, loading: true }));
    const result = await loadEmailReplies();
    if (requestId !== inboxRequestRef.current) return;
    setInbox((current) =>
      result.ok
        ? { loading: false, error: null, replies: result.data ?? [] }
        : { loading: false, error: result.error, replies: current.replies },
    );
  }, []);
  useEffect(() => {
    reloadInbox();
  }, [reloadInbox]);

  const [pendingReplySeenIds, setPendingReplySeenIds] = useState(new Set());
  const [replySeenError, setReplySeenError] = useState(null);
  const submitRepliesSeen = async (items) => {
    if (items.length === 0) return;
    const ids = new Set(items.map((i) => i.orderId));
    setPendingReplySeenIds(ids);
    setReplySeenError(null);
    try {
      const result = await markRepliesSeen(items);
      if (result?.ok === false) {
        setReplySeenError(result.message);
      } else {
        setInbox((current) => ({
          ...current,
          replies: current.replies.filter((r) => !ids.has(r.orderId)),
        }));
      }
    } catch (error) {
      setReplySeenError(error instanceof Error ? error.message : "Could not mark as seen.");
    } finally {
      setPendingReplySeenIds(new Set());
    }
  };

  const threadModalRef = useRef(null);
  const replyModalRef = useRef(null);
  const [emailTarget, setEmailTarget] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [threadOpenCount, setThreadOpenCount] = useState(0);
  const [replyOpenCount, setReplyOpenCount] = useState(0);
  const targetOf = (item) => ({ orderId: item.orderId, name: item.name, legacyId: item.legacyId });
  const replyToOf = (message) =>
    message
      ? {
          subject: message.subject,
          messageId: message.messageId,
          fromName: message.fromName,
          text: message.text,
        }
      : null;
  const viewEmails = (item) => {
    setEmailTarget(targetOf(item));
    setThreadOpenCount((n) => n + 1);
  };
  const replyToEmail = (item) => {
    setEmailTarget(targetOf(item));
    setReplyTo(replyToOf(item));
    setReplyOpenCount((n) => n + 1);
  };
  const replyFromThread = (message) => {
    setReplyTo(replyToOf(message));
    setReplyOpenCount((n) => n + 1);
    threadModalRef.current?.hideOverlay?.();
    replyModalRef.current?.showOverlay?.();
  };

  // ── Refresh and background diff ─────────────────────────────────────────────
  const lastUpdatedLabel = useSmartRefresh({
    isTodayView: tabParam === "today",
    paused: modalOpen || bulk.isSubmitting,
    dataStamp: data,
    reload: () => {
      reloadInbox();
      return reload({ background: true });
    },
  });
  const { newIds: newOrderIds, changedIds: changedOrderIds, dismiss: dismissOrdersDiff } =
    useOrdersDiff(displayedOrders, queryKey);
  const ordersDiffTitle = [
    newOrderIds.size > 0 ? `${newOrderIds.size} new ${newOrderIds.size === 1 ? "order" : "orders"}` : "",
    changedOrderIds.size > 0
      ? `${changedOrderIds.size} schedule ${changedOrderIds.size === 1 ? "update" : "updates"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const [refreshing, setRefreshing] = useState(false);
  const manualRefresh = async () => {
    setRefreshing(true);
    reloadInbox();
    await reload({ background: true });
    setRefreshing(false);
  };

  // ── Recent reschedules ──────────────────────────────────────────────────────
  const [pendingSeenIds, setPendingSeenIds] = useState(new Set());
  const [seenError, setSeenError] = useState(null);
  const submitReschedulesSeen = async (items) => {
    if (items.length === 0) return;
    setPendingSeenIds(new Set(items.map((i) => i.orderId)));
    setSeenError(null);
    try {
      const result = await markReschedulesSeen(items);
      if (result?.ok === false) setSeenError(result.message);
      await reload({ background: true });
    } catch (error) {
      setSeenError(error instanceof Error ? error.message : "Could not mark as seen.");
    } finally {
      setPendingSeenIds(new Set());
    }
  };

  // ── URL-driven filters ──────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState(searchParams.get("search")?.trim() ?? "");
  const searchParamRef = useRef(searchTerm);
  useEffect(() => {
    searchParamRef.current = searchParam;
    setSearchTerm(searchParam);
  }, [searchParam]);
  useEffect(() => {
    if (searchTerm === searchParamRef.current) return;
    const timer = setTimeout(() => {
      searchParamRef.current = searchTerm;
      const params = new URLSearchParams(searchParams);
      if (searchTerm.trim()) params.set("search", searchTerm.trim());
      else params.delete("search");
      params.delete("after");
      params.delete("before");
      navigate(params);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm, searchParams, navigate]);

  const withParams = (mutate, { keepSelection = false } = {}) => {
    const params = new URLSearchParams(searchParams);
    mutate(params);
    params.delete("after");
    params.delete("before");
    if (!keepSelection) clearSelection();
    navigate(params);
  };

  const handleTabChange = (tab) =>
    withParams((p) => (tab === "all" ? p.delete("tab") : p.set("tab", tab)));
  const handleDateChange = (value) => {
    const iso = normalizeDateToISO(value);
    withParams((p) => (iso ? p.set("deliveryDate", iso) : p.delete("deliveryDate")));
  };
  const handleTimeWindowChange = (value) =>
    withParams((p) => (value ? p.set("timeWindow", value) : p.delete("timeWindow")));
  const handleSortChange = (value) =>
    withParams((p) => (value === DEFAULT_SORT ? p.delete("sort") : p.set("sort", value)), {
      keepSelection: true,
    });
  const handleClearFilters = () => {
    setSearchTerm("");
    withParams((p) => {
      p.delete("search");
      p.delete("tab");
      p.delete("timeWindow");
      p.delete("deliveryDate");
    });
  };
  const showSearchInAll = () =>
    withParams((p) => {
      p.delete("tab");
      p.delete("timeWindow");
      p.delete("deliveryDate");
    });
  const openRecentReschedule = (item) => {
    hideModals();
    withParams((p) => {
      p.delete("tab");
      p.delete("timeWindow");
      p.delete("deliveryDate");
      p.set("search", item.name.replace(/^#/, ""));
    });
  };

  const handleNextPage = () => {
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("after", pageInfo.endCursor);
    params.delete("before");
    navigate(params);
  };
  const handlePreviousPage = () => {
    if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("before", pageInfo.startCursor);
    params.delete("after");
    navigate(params);
  };

  // ── Derived view data ───────────────────────────────────────────────────────
  const kpis = useMemo(
    () => computeOrderKpis(displayedOrders, dateRefs.todayISO),
    [displayedOrders, dateRefs.todayISO],
  );
  const tabCounts = useMemo(() => computeTabCounts(orders, dateRefs), [orders, dateRefs]);
  const tabDefs = data
    ? buildOrdersTabDefs({
        orders,
        tabCounts,
        tabParam,
        pageSize: data.pageSize,
        dateScoped: data.dateScoped,
        pageInfo,
      })
    : [];
  const removeTagSuggestions = useMemo(
    () => collectSelectedTags(displayedOrders, selectedIds),
    [displayedOrders, selectedIds],
  );
  const hiddenSearchMatches = useMemo(
    () =>
      findHiddenSearchMatches(orders, displayedOrders.length, {
        searchParam,
        tabParam,
        deliveryDateFilter,
        timeWindowParam,
      }),
    [orders, displayedOrders.length, searchParam, tabParam, deliveryDateFilter, timeWindowParam],
  );
  const hasActiveFilters = Boolean(
    searchParam || timeWindowParam || deliveryDateFilter || tabParam !== "all",
  );
  const loadErrors = data?.errors ? data.errors.map((e) => e.message).join(", ") : loadError;
  const selectedCount = selectedIds.length;

  return (
    <s-page heading="Orders Operations" inlineSize="large">
      <s-button slot="secondary-actions" href="/settings">
        Delivery Scheduler
      </s-button>

      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="end" alignItems="center" gap="small">
          <s-text color="subdued">{lastUpdatedLabel}</s-text>
          <s-button variant="tertiary" loading={refreshing} onClick={manualRefresh} accessibilityLabel="Refresh orders">
            Refresh
          </s-button>
          <NotificationsBell
            replies={inbox.replies}
            repliesLoading={inbox.loading}
            repliesError={inbox.error}
            reschedules={data?.recentReschedules ?? []}
            pendingReplySeenIds={pendingReplySeenIds}
            pendingRescheduleSeenIds={pendingSeenIds}
            seenError={replySeenError || seenError}
            timezone={data?.shopTimezone ?? "Asia/Manila"}
            todayISO={todayISO}
            onCheckInbox={() => reloadInbox(60_000)}
            onViewReply={viewEmails}
            onReply={replyToEmail}
            onReplySeen={submitRepliesSeen}
            onOpenReschedule={openRecentReschedule}
            onRescheduleSeen={submitReschedulesSeen}
          />
        </s-stack>

        {loadErrors && !errorDismissed && (
          <s-banner tone="critical" heading="Failed to load orders" dismissible onDismiss={() => setErrorDismissed(true)}>
            {loadErrors}
          </s-banner>
        )}

        <RecentReschedules
          items={data?.recentReschedules ?? []}
          pendingSeenIds={pendingSeenIds}
          errorMessage={seenError}
          onOpen={openRecentReschedule}
          onSeen={(item) => submitReschedulesSeen([item])}
          onSeenAll={submitReschedulesSeen}
        />

        {hiddenSearchMatches.length > 0 && (
          <s-banner tone="info" heading="No match in this view">
            {`Found in All: ${hiddenSearchMatches.map((m) => `${m.name} · ${m.when}`).join(", ")}${
              orders.length > hiddenSearchMatches.length ? " and more" : ""
            }.`}
            <s-button slot="secondary-actions" onClick={showSearchInAll}>
              Show in All
            </s-button>
          </s-banner>
        )}

        {ordersDiffTitle && (
          <s-banner tone="info" heading={ordersDiffTitle} dismissible onDismiss={dismissOrdersDiff}>
            This view changed since the last refresh — new and updated rows are marked in the table below.
          </s-banner>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="small">
          <Kpi label="Orders · this page" value={String(kpis.kpiOrderCount)}>
            <s-stack direction="inline" gap="small" alignItems="center">
              {tabCounts.today > 0 && <s-text color="subdued">{`${tabCounts.today} delivering today`}</s-text>}
              <s-button
                variant="tertiary"
                commandFor={INFO_MODAL_ID}
                command="--show"
                onClick={() => setInfo({ kind: "products" })}
              >
                Items to prepare
              </s-button>
            </s-stack>
          </Kpi>
          <Kpi label="Revenue · this page" value={kpis.kpiRevenue}>
            {kpis.kpiAvgRevenue && <s-text color="subdued">{kpis.kpiAvgRevenue}</s-text>}
          </Kpi>
          <s-clickable accessibilityLabel="Show unpaid orders" onClick={() => handleTabChange("unpaid")}>
            <Kpi
              label="Unpaid · this page"
              value={String(kpis.kpiUnpaidCount)}
              tone={kpis.kpiUnpaidCount > 0 ? "critical" : undefined}
            >
              {kpis.kpiUnpaidTotal && (
                <s-text tone={kpis.kpiUnpaidCount > 0 ? "critical" : undefined} color="subdued">
                  {kpis.kpiUnpaidTotal}
                </s-text>
              )}
            </Kpi>
          </s-clickable>
          <s-clickable accessibilityLabel="Show unfulfilled orders" onClick={() => handleTabChange("unfulfilled")}>
            <Kpi
              label="Unfulfilled · this page"
              value={String(kpis.kpiUnfulfilledCount)}
              tone={kpis.kpiUnfulfilledCount > 0 ? "critical" : undefined}
            >
              {kpis.kpiUnfulfilledDueToday > 0 && (
                <s-text tone="critical">{`${kpis.kpiUnfulfilledDueToday} due today or earlier`}</s-text>
              )}
            </Kpi>
          </s-clickable>
          <Kpi label="Delivery Fees · this page" value={kpis.kpiDeliveryFees} />
        </s-grid>

        {selectedCount > 0 && (
          <s-box padding="small" background="subdued" borderRadius="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{`${selectedCount} selected`}</s-text>
              <s-button commandFor={RESCHEDULE_MODAL_ID} command="--show" disabled={bulk.isSubmitting} onClick={openReschedule}>
                Update delivery slot
              </s-button>
              {[
                ["markFulfilled", "Mark as fulfilled"],
                ["markAsPaid", "Mark as paid"],
                ["addTags", "Add tags"],
                ["removeTags", "Remove tags"],
                ["archive", "Archive orders"],
                ["unarchive", "Unarchive orders"],
              ].map(([name, label]) => (
                <s-button
                  key={name}
                  commandFor={BULK_MODAL_ID}
                  command="--show"
                  disabled={bulk.isSubmitting}
                  onClick={() => openBulkModal(name)}
                >
                  {label}
                </s-button>
              ))}
              <s-button
                tone="critical"
                commandFor={BULK_MODAL_ID}
                command="--show"
                disabled={bulk.isSubmitting}
                onClick={() => openBulkModal("cancel")}
              >
                Cancel orders
              </s-button>
              <s-button variant="tertiary" onClick={clearSelection}>
                Clear selection
              </s-button>
            </s-stack>
          </s-box>
        )}

        <OrdersTable
          orders={displayedOrders}
          todayISO={dateRefs.todayISO}
          loading={loading}
          hasNextPage={pageInfo?.hasNextPage || false}
          hasPreviousPage={pageInfo?.hasPreviousPage || false}
          onNextPage={handleNextPage}
          onPreviousPage={handlePreviousPage}
          tabs={tabDefs}
          activeTab={tabParam}
          onTabChange={handleTabChange}
          queryValue={searchTerm}
          onQueryChange={setSearchTerm}
          deliveryDateFilter={deliveryDateFilter}
          onDeliveryDateChange={handleDateChange}
          timeWindow={timeWindowParam}
          onTimeWindowChange={handleTimeWindowChange}
          sortSelected={sortParam}
          onSortChange={handleSortChange}
          onClearFilters={handleClearFilters}
          hasActiveFilters={hasActiveFilters}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onToggleAll={toggleAll}
          onShowTags={(orderId) => {
            setInfo({ kind: "tags", orderId });
            infoModalRef.current?.showOverlay?.();
          }}
          newOrderIds={newOrderIds}
          changedOrderIds={changedOrderIds}
        />
      </s-stack>

      <BulkModal
        modalRef={bulkModalRef}
        name={bulk.activeModal === "reschedule" ? null : bulk.activeModal}
        count={selectedCount}
        isSubmitting={bulk.isSubmitting}
        form={bulk.form}
        suggestedTags={removeTagSuggestions}
        onConfirm={bulk.confirmActive}
        onHide={onModalHide}
      />
      <RescheduleModal
        modalRef={rescheduleModalRef}
        openCount={rescheduleOpenCount}
        targets={rescheduleTargets}
        isSubmitting={bulk.isSubmitting}
        rules={rescheduleRules}
        rulesLoading={rescheduleRulesLoading}
        serverCapacity={rescheduleServerCapacity}
        onConfirm={(date, timeSlot, override, notifyCustomer) =>
          bulk.submitReschedule(selectedIds, date, timeSlot, override, notifyCustomer)
        }
        onHide={onModalHide}
      />
      <ThreadModal
        modalRef={threadModalRef}
        target={emailTarget}
        openCount={threadOpenCount}
        timezone={data?.shopTimezone ?? "Asia/Manila"}
        todayISO={todayISO}
        onReply={replyFromThread}
      />
      <ReplyModal
        modalRef={replyModalRef}
        target={emailTarget}
        replyTo={replyTo}
        openCount={replyOpenCount}
      />
      <s-modal
        id={INFO_MODAL_ID}
        ref={infoModalRef}
        heading={info?.kind === "tags" ? "Attributes" : "Items to prepare"}
        onHide={() => setInfo(null)}
      >
        {info?.kind === "products" &&
          (kpis.kpiProducts.length === 0 ? (
            <s-text color="subdued">No products found.</s-text>
          ) : (
            <s-stack gap="small-300">
              {kpis.kpiProducts.map(([name, qty]) => (
                <s-stack key={name} direction="inline" justifyContent="space-between" alignItems="center">
                  <s-text>{name}</s-text>
                  <s-text type="strong">{`× ${qty}`}</s-text>
                </s-stack>
              ))}
            </s-stack>
          ))}
        {info?.kind === "tags" &&
          (() => {
            const tags = getMeaningfulTags(orders.find((o) => o.id === info.orderId)?.tags || []);
            return tags.length === 0 ? (
              <s-text color="subdued">No tags on this order.</s-text>
            ) : (
              <s-stack direction="inline" gap="small-300">
                {tags.map((tag) => (
                  <s-badge key={tag}>{tagDisplayLabel(tag)}</s-badge>
                ))}
              </s-stack>
            );
          })()}
        <s-button slot="primary-action" commandFor={INFO_MODAL_ID} command="--hide">
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}
