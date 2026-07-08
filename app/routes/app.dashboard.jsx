/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { buildEmbeddedAppPath } from "../lib/embedded-route";
import { loadDashboardDeliveryOrders } from "../services/delivery-orders.server";
import { getScheduleRules } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";
import styles from "../styles/home.module.css";

const STORAGE_KEY = "delivery-dashboard-columns";

const COLUMN_DEFINITIONS = [
  { key: "prepared", label: "Prepared", required: true },
  { key: "order", label: "Order", required: true },
  { key: "deliveryDate", label: "Date" },
  { key: "timeSlot", label: "Time slot" },
  { key: "customer", label: "Customer" },
  { key: "items", label: "Items" },
  { key: "destination", label: "Destination" },
  { key: "phone", label: "Phone" },
  { key: "total", label: "Total" },
  { key: "payment", label: "Payment" },
  { key: "fulfillment", label: "Fulfillment" },
  { key: "actions", label: "Actions", required: true },
];

const DEFAULT_VISIBLE_COLUMNS = COLUMN_DEFINITIONS.map((column) => column.key);

function getTodayString(timezone) {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

function getRelativeDateString(timezone, offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load delivery orders.";
}

function emptyOrdersResult(error) {
  return {
    rows: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    pageSize: 100,
    isTruncated: false,
    error,
    appliedDateFilter: "upcoming",
    appliedTimeSlot: null,
  };
}

function getShopFromSession(session) {
  if (typeof session?.shop === "string" && session.shop) {
    return session.shop;
  }

  throw new Response("Missing authenticated shop session.", { status: 401 });
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = getShopFromSession(session);
  const url = new URL(request.url);
  const deliveryDate = url.searchParams.get("deliveryDate") || "upcoming";
  const timeSlot = url.searchParams.get("timeSlot") || null;
  const cursor = url.searchParams.get("cursor") || null;
  const rules = await getScheduleRules(shop);
  const pageSize = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ? 100 : 250;

  let deliveryOrders;
  try {
    deliveryOrders = await loadDashboardDeliveryOrders(admin, {
      timezone: rules.timezone,
      deliveryDate,
      timeSlot,
      after: cursor,
      pageSize,
    });
  } catch (error) {
    console.error("Failed to load dashboard delivery orders:", error);
    deliveryOrders = emptyOrdersResult(getErrorMessage(error));
  }

  return Response.json(
    {
      shop,
      deliveryOrders,
      scheduleSlots: rules.slots,
      today: getTodayString(rules.timezone),
      tomorrow: getRelativeDateString(rules.timezone, 1),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};

function formatDate(date) {
  if (!date) return "Missing";
  const parsed = new Date(`${date}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function formatMoney(money) {
  if (!money?.amount || !money?.currencyCode) return "-";
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return `${money.amount} ${money.currencyCode}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currencyCode,
  }).format(amount);
}

function formatStatus(value) {
  if (!value) return "-";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusClassName(value) {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("paid") || normalized.includes("fulfilled")) {
    return `${styles.ordersBadge} ${styles.ordersBadgeGood}`;
  }
  if (normalized.includes("pending") || normalized.includes("partial") || normalized.includes("unfulfilled")) {
    return `${styles.ordersBadge} ${styles.ordersBadgeWarning}`;
  }
  return `${styles.ordersBadge} ${styles.ordersBadgeNeutral}`;
}

function extractNumericId(id) {
  const match = String(id ?? "").match(/(\d+)$/);
  return match ? match[1] : null;
}

function buildAdminOrderUrl(shop, id) {
  const numericId = extractNumericId(id);
  if (!shop || !numericId) return null;
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/orders/${numericId}`;
}

function buildOrderSummary(order) {
  const details = [
    `Order: ${order.name}`,
    `Customer: ${order.customerName}${order.customerEmail ? ` <${order.customerEmail}>` : ""}`,
    `Delivery date: ${order.deliveryDate ?? "Missing"}`,
    `Time slot: ${order.timeSlot ?? "Missing"}`,
    `Items: ${order.itemsSummary}`,
    `Address: ${order.destination}`,
  ];

  if (order.phone) details.push(`Phone: ${order.phone}`);
  if (order.note) details.push(`Note: ${order.note}`);
  if (order.cartAttributes?.length) {
    details.push(
      `Attributes: ${order.cartAttributes.map((attribute) => `${attribute.key}: ${attribute.value}`).join("; ")}`,
    );
  }

  return details.join("\n");
}

function hasColumn(visibleColumns, key) {
  return visibleColumns.includes(key);
}

function ColumnConfigModal({ visibleColumns, onChange, onClose }) {
  const toggleColumn = (key) => {
    const definition = COLUMN_DEFINITIONS.find((column) => column.key === key);
    if (definition?.required) return;

    if (visibleColumns.includes(key)) {
      onChange(visibleColumns.filter((columnKey) => columnKey !== key));
      return;
    }

    const nextColumns = DEFAULT_VISIBLE_COLUMNS.filter(
      (columnKey) => columnKey === key || visibleColumns.includes(columnKey),
    );
    onChange(nextColumns);
  };

  return (
    <div
      className={styles.ordersModalBackdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.ordersModal} role="dialog" aria-modal="true">
        <div className={styles.ordersModalHeader}>
          <h2 className={styles.ordersModalTitle}>Configure columns</h2>
          <button className={styles.ordersModalClose} type="button" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <p className={styles.ordersModalHint}>Choose the delivery order columns shown in the table.</p>
        <div className={styles.ordersModalList}>
          {COLUMN_DEFINITIONS.map((column) => (
            <label className={styles.ordersModalRow} key={column.key}>
              <input
                type="checkbox"
                checked={visibleColumns.includes(column.key)}
                disabled={column.required}
                onChange={() => toggleColumn(column.key)}
              />
              <span>{column.label}</span>
              {column.required ? <span className={styles.ordersModalRequired}>Required</span> : null}
            </label>
          ))}
        </div>
        <div className={styles.ordersModalFooter}>
          <button type="button" className={styles.ordersModalDone} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardFilters({ activeDate, activeTimeSlot, slots, today, tomorrow, onChange }) {
  const setDateFilter = (value) => onChange({ deliveryDate: value, cursor: null });
  const setTimeSlotFilter = (value) => onChange({ timeSlot: value || null, cursor: null });

  return (
    <div className={styles.ordersFilterBar}>
      <div className={styles.ordersFilterGroup}>
        <span className={styles.ordersFilterLabel}>Delivery date</span>
        <div className={styles.ordersFilterButtons}>
          <button
            type="button"
            className={`${styles.ordersFilterBtn} ${activeDate === "upcoming" ? styles.ordersFilterBtnActive : ""}`}
            onClick={() => setDateFilter("upcoming")}
          >
            Upcoming
          </button>
          <button
            type="button"
            className={`${styles.ordersFilterBtn} ${activeDate === today ? styles.ordersFilterBtnActive : ""}`}
            onClick={() => setDateFilter(today)}
          >
            Today
          </button>
          <button
            type="button"
            className={`${styles.ordersFilterBtn} ${activeDate === tomorrow ? styles.ordersFilterBtnActive : ""}`}
            onClick={() => setDateFilter(tomorrow)}
          >
            Tomorrow
          </button>
          <input
            className={styles.ordersDateInput}
            type="date"
            value={/^\d{4}-\d{2}-\d{2}$/.test(activeDate) ? activeDate : ""}
            onChange={(event) => {
              if (event.currentTarget.value) setDateFilter(event.currentTarget.value);
            }}
            aria-label="Custom delivery date"
          />
        </div>
      </div>
      <div className={styles.ordersFilterGroup}>
        <span className={styles.ordersFilterLabel}>Time slot</span>
        <div className={styles.ordersFilterButtons}>
          <button
            type="button"
            className={`${styles.ordersFilterBtn} ${!activeTimeSlot ? styles.ordersFilterBtnActive : ""}`}
            onClick={() => setTimeSlotFilter(null)}
          >
            All slots
          </button>
          {slots.map((slot) => (
            <button
              type="button"
              key={slot.value}
              className={`${styles.ordersFilterBtn} ${activeTimeSlot === slot.value ? styles.ordersFilterBtnActive : ""}`}
              onClick={() => setTimeSlotFilter(slot.value)}
            >
              {slot.display}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function OrderActions({ order, shop, isPrepared, onTogglePrepared, onCopied }) {
  const [isOpen, setIsOpen] = useState(false);
  const adminUrl = buildAdminOrderUrl(shop, order.id);

  const copyOrder = async () => {
    try {
      await navigator.clipboard.writeText(buildOrderSummary(order));
      onCopied("Order details copied");
    } catch {
      onCopied("Copy failed");
    }
    setIsOpen(false);
  };

  return (
    <div className={styles.ordersCellActions}>
      <button type="button" className={styles.ordersActionsBtn} onClick={() => setIsOpen((value) => !value)}>
        Actions
      </button>
      {isOpen ? (
        <div className={styles.ordersActionsDropdown}>
          <button type="button" className={styles.ordersActionItem} onClick={copyOrder}>
            Copy delivery details
          </button>
          {adminUrl ? (
            <a className={styles.ordersActionItem} href={adminUrl} target="_blank" rel="noreferrer" onClick={() => setIsOpen(false)}>
              Open order in Admin
            </a>
          ) : (
            <span className={`${styles.ordersActionItem} ${styles.ordersActionDisabled}`}>Open order unavailable</span>
          )}
          <div className={styles.ordersActionDivider} />
          <button
            type="button"
            className={`${styles.ordersActionItem} ${isPrepared ? styles.ordersActionPrepared : ""}`}
            onClick={() => {
              onTogglePrepared(order.id);
              setIsOpen(false);
            }}
          >
            {isPrepared ? "Mark not prepared" : "Mark prepared"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function OrdersTable({ rows, visibleColumns, preparedSet, shop, onTogglePrepared, onCopied }) {
  return (
    <div className={styles.ordersTableWrap}>
      <table className={styles.ordersTable}>
        <thead>
          <tr>
            {COLUMN_DEFINITIONS.filter((column) => hasColumn(visibleColumns, column.key)).map((column) => (
              <th
                key={column.key}
                className={`${styles.ordersThCell} ${column.key === "prepared" ? styles.ordersThPrepared : ""} ${
                  column.key === "actions" ? styles.ordersThActions : ""
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((order) => {
            const isPrepared = preparedSet.has(order.id);
            return (
              <tr key={order.id} className={isPrepared ? styles.ordersPreparedRow : ""}>
                {hasColumn(visibleColumns, "prepared") ? (
                  <td className={styles.ordersCellPrepared} data-label="Prepared">
                    <label className={styles.ordersPreparedLabel}>
                      <input
                        className={styles.ordersPreparedCheck}
                        type="checkbox"
                        aria-label={`Mark ${order.name} prepared`}
                        checked={isPrepared}
                        onChange={() => onTogglePrepared(order.id)}
                      />
                    </label>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "order") ? (
                  <td data-label="Order">
                    <span className={styles.ordersCellPrimary}>{order.name}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "deliveryDate") ? (
                  <td data-label="Date">
                    <span className={order.deliveryDate ? styles.ordersCellDate : styles.ordersCellMissing}>
                      {formatDate(order.deliveryDate)}
                    </span>
                    {!order.deliveryDate ? <span className={styles.ordersWarningDot} aria-hidden="true" /> : null}
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "timeSlot") ? (
                  <td data-label="Time slot">
                    <span className={order.timeSlot ? styles.ordersCellSlot : styles.ordersCellMissing}>
                      {order.timeSlot ?? "Missing"}
                    </span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "customer") ? (
                  <td data-label="Customer">
                    <span className={styles.ordersCustomer}>
                      <span>{order.customerName}</span>
                      {order.customerEmail ? <span className={styles.ordersCustomerEmail}>{order.customerEmail}</span> : null}
                    </span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "items") ? (
                  <td data-label="Items">
                    <span className={styles.ordersCellMuted}>{order.itemsSummary}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "destination") ? (
                  <td className={styles.ordersCellAddress} data-label="Destination" title={order.destination}>
                    <span className={styles.ordersCellAddressText}>{order.destination}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "phone") ? (
                  <td data-label="Phone">
                    <span className={styles.ordersCellMuted}>{order.phone ?? "-"}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "total") ? <td data-label="Total">{formatMoney(order.total)}</td> : null}
                {hasColumn(visibleColumns, "payment") ? (
                  <td data-label="Payment">
                    <span className={statusClassName(order.paymentStatus)}>{formatStatus(order.paymentStatus)}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "fulfillment") ? (
                  <td data-label="Fulfillment">
                    <span className={statusClassName(order.fulfillmentStatus)}>{formatStatus(order.fulfillmentStatus)}</span>
                  </td>
                ) : null}
                {hasColumn(visibleColumns, "actions") ? (
                  <td data-label="Actions">
                    <OrderActions
                      order={order}
                      shop={shop}
                      isPrepared={isPrepared}
                      onTogglePrepared={onTogglePrepared}
                      onCopied={onCopied}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { shop, deliveryOrders, scheduleSlots, today, tomorrow } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [preparedSet, setPreparedSet] = useState(() => new Set());
  const [showColumnConfig, setShowColumnConfig] = useState(false);
  const [copyToast, setCopyToast] = useState("");
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_VISIBLE_COLUMNS);

  const activeDate = searchParams.get("deliveryDate") || deliveryOrders.appliedDateFilter || "upcoming";
  const activeTimeSlot = searchParams.get("timeSlot") || deliveryOrders.appliedTimeSlot || null;
  const rows = deliveryOrders.rows ?? [];

  useEffect(() => {
    try {
      const savedColumns = window.localStorage.getItem(STORAGE_KEY);
      if (!savedColumns) return;
      const parsedColumns = JSON.parse(savedColumns);
      if (!Array.isArray(parsedColumns)) return;
      const knownColumns = parsedColumns.filter((column) =>
        COLUMN_DEFINITIONS.some((definition) => definition.key === column),
      );
      const requiredColumns = COLUMN_DEFINITIONS.filter((column) => column.required).map((column) => column.key);
      setVisibleColumns([...new Set([...knownColumns, ...requiredColumns])]);
    } catch {
      setVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  useEffect(() => {
    setPreparedSet(new Set());
  }, [activeDate, activeTimeSlot]);

  useEffect(() => {
    if (!copyToast) return undefined;
    const timeoutId = window.setTimeout(() => setCopyToast(""), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [copyToast]);

  const updateSearch = (changes) => {
    const nextParams = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    }
    setSearchParams(nextParams);
  };

  const loadMore = () => {
    if (!deliveryOrders.pageInfo?.hasNextPage || !deliveryOrders.pageInfo?.endCursor) return;
    updateSearch({ cursor: deliveryOrders.pageInfo.endCursor });
  };

  const dashboardHref = useMemo(() => buildEmbeddedAppPath("/app/dashboard", searchParams), [searchParams]);

  return (
    <s-page heading="Delivery operations">
      <section className={styles.ordersSection}>
        <div className={styles.ordersSectionHeader}>
          <div className={styles.ordersSectionTitleGroup}>
            <h2 className={styles.ordersSectionTitle}>Delivery orders</h2>
            <button type="button" className={styles.ordersPrintBtn} onClick={() => window.print()}>
              Print
            </button>
          </div>
          <button type="button" className={styles.ordersConfigBtn} onClick={() => setShowColumnConfig(true)}>
            Configure columns
          </button>
        </div>

        <DashboardFilters
          activeDate={activeDate}
          activeTimeSlot={activeTimeSlot}
          slots={scheduleSlots}
          today={today}
          tomorrow={tomorrow}
          onChange={updateSearch}
        />

        {deliveryOrders.error ? (
          <p className={styles.ordersEmpty}>{deliveryOrders.error}</p>
        ) : rows.length ? (
          <OrdersTable
            rows={rows}
            visibleColumns={visibleColumns}
            preparedSet={preparedSet}
            shop={shop}
            onTogglePrepared={(id) => {
              setPreparedSet((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onCopied={setCopyToast}
          />
        ) : (
          <p className={styles.ordersEmpty}>No delivery orders found for the current filters.</p>
        )}

        <div className={styles.ordersTableFooter}>
          <span className={styles.ordersPaginationMeta}>
            Showing {rows.length} order{rows.length === 1 ? "" : "s"}
            {deliveryOrders.isTruncated ? <span className={styles.ordersTruncatedNote}> - More orders may be available</span> : null}
          </span>
          {deliveryOrders.pageInfo?.hasNextPage ? (
            <div className={styles.ordersPagination}>
              <button type="button" className={styles.ordersFilterBtn} onClick={loadMore}>
                Load more
              </button>
            </div>
          ) : null}
        </div>

        {showColumnConfig ? (
          <ColumnConfigModal
            visibleColumns={visibleColumns}
            onChange={setVisibleColumns}
            onClose={() => setShowColumnConfig(false)}
          />
        ) : null}
        {copyToast ? <div className={styles.copyToast}>{copyToast}</div> : null}
      </section>
      <s-section slot="aside" heading="Dashboard route">
        <s-paragraph>
          <s-link href={dashboardHref}>Refresh delivery dashboard</s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};