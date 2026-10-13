import {
  formatDeliveryDate,
  formatMoney,
  financialStatusTone,
  fulfillmentBadge,
  isOpenDeliverableOrder,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getCity,
  getInstructionValue,
} from "../../../../app/lib/order-utils";

const TIME_SLOT_CHOICES = [
  { label: "9AM–12PM", value: "9AM-12PM" },
  { label: "12PM–3PM", value: "12PM-3PM" },
  { label: "3PM–6PM", value: "3PM-6PM" },
  { label: "6PM–11PM", value: "6PM-11PM" },
];

const SORT_OPTIONS = [
  { label: "Order date · Newest first", value: "orderDate desc" },
  { label: "Order date · Oldest first", value: "orderDate asc" },
  { label: "Delivery date · Earliest first", value: "deliveryDate asc" },
  { label: "Delivery date · Latest first", value: "deliveryDate desc" },
];

function itemsText(order) {
  const items = order.lineItems?.edges || [];
  const itemCount = items.length;
  const totalQty = items.reduce((sum, item) => sum + (item.node.quantity || 0), 0);
  return itemCount === 0
    ? "—"
    : itemCount === 1
      ? `×${totalQty}`
      : itemCount >= 10
        ? "10+ items"
        : `${itemCount} items`;
}

function OrderRow({ order, todayISO, selected, onToggle, onShowTags, newOrChanged }) {
  const customerName = getCustomerName(order) === "—" ? "Guest" : getCustomerName(order);
  const instructionText = getInstructionValue(order);
  const rawDeliveryDate = getDeliveryDateValue(order);
  const timeWindowValue = getDeliveryTimeValue(order);
  const isOpenOrder = isOpenDeliverableOrder(order);
  const ffBadge = fulfillmentBadge(order);
  const deliveryRelative =
    rawDeliveryDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDeliveryDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDeliveryDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDeliveryDate, todayISO);
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const meaningfulTags = getMeaningfulTags(order.tags || []);
  const shownTags = meaningfulTags.slice(0, 2);
  const extraTags = meaningfulTags.length - shownTags.length;
  const legacyId = order.id.split("/").pop();

  return (
    <s-table-row>
      <s-table-cell>
        <s-checkbox
          accessibilityLabel={`Select order ${order.name}`}
          checked={selected}
          onChange={() => onToggle(order.id)}
        />
      </s-table-cell>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-link href={`shopify://admin/orders/${legacyId}`} target="_blank">
              {order.name}
            </s-link>
            {newOrChanged === "new" && <s-badge tone="success">New</s-badge>}
            {newOrChanged === "changed" && <s-badge tone="caution">Updated</s-badge>}
            {instructionText !== "—" && (
              <s-icon type="note" tone="subdued" accessibilityLabel={`Note: ${instructionText}`} />
            )}
          </s-stack>
          {order.createdAt && (
            <s-text color="subdued">
              {new Date(order.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </s-text>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{itemsText(order)}</s-table-cell>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-text type="strong">{customerName}</s-text>
          {order.customer?.defaultEmailAddress?.emailAddress && (
            <s-text color="subdued">{order.customer.defaultEmailAddress.emailAddress}</s-text>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>{getCity(order)}</s-table-cell>
      <s-table-cell>
        <s-stack gap="small-500">
          {rawDeliveryDate !== "—" ? (
            <s-text type="strong">{formatDeliveryDate(rawDeliveryDate)}</s-text>
          ) : (
            <s-text color="subdued">—</s-text>
          )}
          {deliveryRelative && (
            <s-badge tone={deliveryOverdue ? "critical" : "neutral"}>{deliveryRelative}</s-badge>
          )}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {timeWindowValue === "—" ? <s-text color="subdued">—</s-text> : timeWindowValue}
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={financialStatusTone(order.displayFinancialStatus)}>
          {formatStatusLabel(order.displayFinancialStatus)}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={ffBadge.tone}>{ffBadge.label}</s-badge>
      </s-table-cell>
      <s-table-cell>{total}</s-table-cell>
      <s-table-cell>
        {meaningfulTags.length === 0 ? (
          <s-text color="subdued">—</s-text>
        ) : (
          <s-stack direction="inline" gap="small-300" alignItems="center">
            {shownTags.map((tag) => (
              <s-badge key={tag}>
                {tag.trim().toLowerCase() === "resched" && order.rescheduleBadgeLabel
                  ? order.rescheduleBadgeLabel
                  : tagDisplayLabel(tag)}
              </s-badge>
            ))}
            {extraTags > 0 && (
              <s-button variant="tertiary" onClick={() => onShowTags(order.id)}>
                {`+${extraTags}`}
              </s-button>
            )}
          </s-stack>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

export function OrdersTable({
  orders,
  todayISO,
  loading,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
  tabs,
  activeTab,
  onTabChange,
  queryValue,
  onQueryChange,
  deliveryDateFilter,
  onDeliveryDateChange,
  timeWindow,
  onTimeWindowChange,
  sortSelected,
  onSortChange,
  onClearFilters,
  hasActiveFilters,
  selectedIds,
  onToggle,
  onToggleAll,
  onShowTags,
  newOrderIds,
  changedOrderIds,
}) {
  const allSelected = orders.length > 0 && orders.every((o) => selectedIds.includes(o.id));

  const handleDateChange = (event) => {
    const value = event.currentTarget.value;
    if (value === "") {
      onDeliveryDateChange("");
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 2000) {
      onDeliveryDateChange(value);
    }
  };

  return (
    <s-section padding="none">
      <s-box padding="small">
        <s-stack gap="small">
          <s-stack direction="inline" gap="small-300">
            {tabs.map((tab) => (
              <s-button
                key={tab.id}
                variant={tab.id === activeTab ? "secondary" : "tertiary"}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.count !== null && tab.count > 0
                  ? `${tab.label} (${tab.count}${tab.approximate ? "+" : ""})`
                  : tab.label}
              </s-button>
            ))}
          </s-stack>
          <s-grid gridTemplateColumns="2fr 1fr 1fr 1fr" gap="small" alignItems="end">
            <s-search-field
              label="Search orders"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by order, customer, phone, city"
              value={queryValue}
              onInput={(event) => onQueryChange(event.currentTarget.value)}
            />
            <s-date-field
              label="Delivery date"
              value={deliveryDateFilter}
              onChange={handleDateChange}
            />
            <s-select
              label="Time slot"
              value={timeWindow}
              onChange={(event) => onTimeWindowChange(event.currentTarget.value)}
            >
              <s-option value="">All time slots</s-option>
              {TIME_SLOT_CHOICES.map((choice) => (
                <s-option key={choice.value} value={choice.value}>
                  {choice.label}
                </s-option>
              ))}
            </s-select>
            <s-select
              label="Sort"
              value={sortSelected}
              onChange={(event) => onSortChange(event.currentTarget.value)}
            >
              {SORT_OPTIONS.map((option) => (
                <s-option key={option.value} value={option.value}>
                  {option.label}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          {hasActiveFilters && (
            <s-stack direction="inline">
              <s-button variant="tertiary" onClick={onClearFilters}>
                Clear filters
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-box>

      {orders.length === 0 && !loading ? (
        <s-box padding="base">
          <s-stack gap="small" alignItems="center">
            <s-heading>{hasActiveFilters ? "No orders match this view" : "No orders found"}</s-heading>
            <s-text color="subdued">
              {hasActiveFilters
                ? "Try adjusting or clearing your filters."
                : "Orders will appear here after customers place them."}
            </s-text>
          </s-stack>
        </s-box>
      ) : (
        <s-table
          loading={loading}
          paginate
          hasNextPage={hasNextPage}
          hasPreviousPage={hasPreviousPage}
          onNextPage={onNextPage}
          onPreviousPage={onPreviousPage}
        >
          <s-table-header-row>
            <s-table-header>
              <s-checkbox
                accessibilityLabel="Select all orders on this page"
                checked={allSelected}
                onChange={() => onToggleAll(!allSelected)}
              />
            </s-table-header>
            <s-table-header listSlot="primary">Order</s-table-header>
            <s-table-header>Items</s-table-header>
            <s-table-header>Customer</s-table-header>
            <s-table-header>City</s-table-header>
            <s-table-header>Delivery date</s-table-header>
            <s-table-header>Time window</s-table-header>
            <s-table-header>Payment</s-table-header>
            <s-table-header>Fulfillment</s-table-header>
            <s-table-header format="currency">Total</s-table-header>
            <s-table-header>Tags</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                todayISO={todayISO}
                selected={selectedIds.includes(order.id)}
                onToggle={onToggle}
                onShowTags={onShowTags}
                newOrChanged={
                  newOrderIds.has(order.id)
                    ? "new"
                    : changedOrderIds.has(order.id)
                      ? "changed"
                      : null
                }
              />
            ))}
          </s-table-body>
        </s-table>
      )}
    </s-section>
  );
}
