import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ChoiceList,
  EmptySearchResult,
  IndexFilters,
  IndexTable,
  InlineStack,
  Text,
  TextField,
  Thumbnail,
  useSetIndexFiltersMode,
  type IndexFiltersProps,
  type IndexTableProps,
} from "@shopify/polaris";
import {
  type Order,
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
  getFirstItemImageUrl,
  getFirstItemAltText,
} from "../../lib/order-utils";
import { polarisBadgeTone } from "./panel/badge-tone";
import type { BulkModalName } from "../../hooks/useBulkActions";

// IndexFilters + IndexTable presentation for /app/orders (Orders Ops V2
// Phase 2). Pure presentation: every filter/tab/sort/pagination change is
// reported to the route via callbacks, which map them onto the existing URL
// params — the loader contract is unchanged.

export interface OrdersTabDef {
  id: string;
  label: string;
  count: number;
}

const TIME_SLOT_CHOICES = [
  { label: "9AM–12PM", value: "9AM-12PM" },
  { label: "12PM–3PM", value: "12PM-3PM" },
  { label: "3PM–6PM", value: "3PM-6PM" },
  { label: "6PM–11PM", value: "6PM-11PM" },
];

const SORT_OPTIONS: IndexFiltersProps["sortOptions"] = [
  { label: "Order date", value: "orderDate desc", directionLabel: "Newest first" },
  { label: "Order date", value: "orderDate asc", directionLabel: "Oldest first" },
  { label: "Delivery date", value: "deliveryDate asc", directionLabel: "Earliest first" },
  { label: "Delivery date", value: "deliveryDate desc", directionLabel: "Latest first" },
];

export interface OrdersIndexTableProps {
  orders: Order[];
  todayISO: string;
  loading: boolean;
  isSubmitting: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPreviousPage: () => void;
  tabs: OrdersTabDef[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  queryValue: string;
  onQueryChange: (value: string) => void;
  onQueryClear: () => void;
  deliveryDateFilter: string;
  onDeliveryDateChange: (value: string) => void;
  timeWindow: string;
  onTimeWindowChange: (value: string) => void;
  sortSelected: string;
  onSortChange: (value: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  selectedResources: string[];
  allResourcesSelected: boolean;
  onSelectionChange: IndexTableProps["onSelectionChange"];
  onOpenOrder: (orderId: string) => void;
  onShowTags: (orderId: string) => void;
  onOpenBulkModal: (name: BulkModalName) => void;
  // Background-refresh diff (§6): orders that appeared / changed schedule
  // since the last refresh of the same view get a small badge until the
  // nudge banner is dismissed.
  newOrderIds?: ReadonlySet<string>;
  changedOrderIds?: ReadonlySet<string>;
}

export function OrdersIndexTable({
  orders,
  todayISO,
  loading,
  isSubmitting,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPreviousPage,
  tabs,
  activeTab,
  onTabChange,
  queryValue,
  onQueryChange,
  onQueryClear,
  deliveryDateFilter,
  onDeliveryDateChange,
  timeWindow,
  onTimeWindowChange,
  sortSelected,
  onSortChange,
  onClearFilters,
  hasActiveFilters,
  selectedResources,
  allResourcesSelected,
  onSelectionChange,
  onOpenOrder,
  onShowTags,
  onOpenBulkModal,
  newOrderIds,
  changedOrderIds,
}: OrdersIndexTableProps) {
  const { mode, setMode } = useSetIndexFiltersMode();

  // Local draft for the delivery-date filter. Native date inputs emit
  // incomplete years while the merchant is still typing (e.g. "0002-07-11"
  // after the first digit of 2026), and committing those immediately both
  // stored garbage dates and re-rendered the popover mid-keystroke (2026-07-11
  // smoke test round 2). Commit only an empty value (clear) or a complete,
  // sane date.
  const [dateDraft, setDateDraft] = useState(deliveryDateFilter);
  useEffect(() => {
    setDateDraft(deliveryDateFilter);
  }, [deliveryDateFilter]);
  const handleDateDraftChange = (value: string) => {
    setDateDraft(value);
    if (value === "") {
      onDeliveryDateChange("");
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 2000) {
      onDeliveryDateChange(value);
    }
  };

  const filters: IndexFiltersProps["filters"] = [
    {
      key: "deliveryDate",
      label: "Delivery date",
      filter: (
        <TextField
          label="Delivery date"
          type="date"
          value={dateDraft}
          onChange={handleDateDraftChange}
          autoComplete="off"
        />
      ),
      pinned: true,
    },
    {
      key: "timeWindow",
      label: "Time slot",
      filter: (
        <ChoiceList
          title="Time slot"
          titleHidden
          choices={TIME_SLOT_CHOICES}
          selected={timeWindow ? [timeWindow] : []}
          onChange={(values) => onTimeWindowChange(values[0] ?? "")}
        />
      ),
      pinned: true,
    },
  ];

  const appliedFilters: IndexFiltersProps["appliedFilters"] = [];
  if (deliveryDateFilter) {
    appliedFilters.push({
      key: "deliveryDate",
      label: `Delivery date: ${formatDeliveryDate(deliveryDateFilter)}`,
      onRemove: () => onDeliveryDateChange(""),
    });
  }
  if (timeWindow) {
    appliedFilters.push({
      key: "timeWindow",
      label: `Time slot: ${timeWindow}`,
      onRemove: () => onTimeWindowChange(""),
    });
  }

  const promotedBulkActions = [
    {
      content: "Update delivery slot",
      onAction: () => onOpenBulkModal("reschedule"),
      disabled: isSubmitting,
    },
    {
      content: "Mark as fulfilled",
      onAction: () => onOpenBulkModal("markFulfilled"),
      disabled: isSubmitting,
    },
    {
      content: "Add tags",
      onAction: () => onOpenBulkModal("addTags"),
      disabled: isSubmitting,
    },
    {
      content: "Remove tags",
      onAction: () => onOpenBulkModal("removeTags"),
      disabled: isSubmitting,
    },
  ];
  const bulkActions = [
    {
      content: "Archive orders",
      onAction: () => onOpenBulkModal("archive"),
      disabled: isSubmitting,
    },
    {
      content: "Unarchive orders",
      onAction: () => onOpenBulkModal("unarchive"),
      disabled: isSubmitting,
    },
    {
      content: "Cancel orders",
      destructive: true,
      onAction: () => onOpenBulkModal("cancel"),
      disabled: isSubmitting,
    },
  ];

  const emptyStateMarkup = (
    <BlockStack gap="300" inlineAlign="center">
      <EmptySearchResult
        title={hasActiveFilters ? "No orders match this view" : "No orders found"}
        description={
          hasActiveFilters
            ? "Try adjusting or clearing your filters."
            : "Orders will appear here after customers place them."
        }
        withIllustration
      />
      {hasActiveFilters && (
        <Button onClick={onClearFilters}>Clear filters</Button>
      )}
    </BlockStack>
  );

  const rowMarkup = orders.map((order, index) => {
    const customerName =
      getCustomerName(order) === "—" ? "Guest" : getCustomerName(order);
    const instructionText = getInstructionValue(order);
    const rawDeliveryDate = getDeliveryDateValue(order);
    const deliveryDateDisplay =
      rawDeliveryDate !== "—" ? formatDeliveryDate(rawDeliveryDate) : "—";
    const timeWindowValue = getDeliveryTimeValue(order);
    const isOpenOrder = isOpenDeliverableOrder(order);
    const ffBadge = fulfillmentBadge(order);
    const deliveryRelative =
      rawDeliveryDate !== "—" && isOpenOrder
        ? getDeliveryRelativeLabel(rawDeliveryDate, todayISO)
        : "";
    const deliveryOverdue =
      rawDeliveryDate !== "—" &&
      isOpenOrder &&
      isDeliveryOverdue(rawDeliveryDate, todayISO);
    const total = order.currentTotalPriceSet
      ? formatMoney(
          order.currentTotalPriceSet.shopMoney.amount,
          order.currentTotalPriceSet.shopMoney.currencyCode,
        )
      : "—";
    const items = order.lineItems?.edges || [];
    const itemCount = items.length;
    const totalQty = items.reduce(
      (sum, item) => sum + (item.node.quantity || 0),
      0,
    );
    const itemsText =
      itemCount === 0
        ? "—"
        : itemCount === 1
          ? `×${totalQty}`
          : itemCount >= 10
            ? "10+ items"
            : `${itemCount} items`;
    const thumbnailUrl = getFirstItemImageUrl(order);
    const meaningfulTags = getMeaningfulTags(order.tags || []);
    const shownTags = meaningfulTags.slice(0, 2);
    const extraTags = meaningfulTags.length - shownTags.length;

    return (
      <IndexTable.Row
        id={order.id}
        key={order.id}
        selected={selectedResources.includes(order.id)}
        position={index}
        onClick={() => onOpenOrder(order.id)}
        accessibilityLabel={`Select order ${order.name}`}
      >
        <IndexTable.Cell>
          <BlockStack gap="050">
            <InlineStack gap="100" blockAlign="center" wrap={false}>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {order.name}
              </Text>
              {newOrderIds?.has(order.id) ? (
                <Badge tone="success" size="small">
                  New
                </Badge>
              ) : changedOrderIds?.has(order.id) ? (
                <Badge tone="attention" size="small">
                  Updated
                </Badge>
              ) : null}
              {instructionText !== "—" && (
                <span
                  title={instructionText}
                  aria-label={`Note: ${instructionText}`}
                  role="img"
                  style={{ display: "inline-flex", color: "var(--p-color-icon-secondary, #8a8a8a)" }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 14 14"
                    fill="none"
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
                    <line x1="3.5" y1="4.5" x2="10.5" y2="4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    <line x1="3.5" y1="7" x2="10.5" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    <line x1="3.5" y1="9.5" x2="7.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </span>
              )}
            </InlineStack>
            {order.createdAt && (
              <Text as="span" variant="bodySm" tone="subdued">
                {new Date(order.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </Text>
            )}
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {thumbnailUrl && (
              <Thumbnail
                source={thumbnailUrl}
                alt={getFirstItemAltText(order)}
                size="small"
              />
            )}
            <Text as="span">{itemsText}</Text>
          </InlineStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" fontWeight="semibold">
              {customerName}
            </Text>
            {order.customer?.defaultEmailAddress?.emailAddress && (
              <Text as="span" variant="bodySm" tone="subdued">
                {order.customer.defaultEmailAddress.emailAddress}
              </Text>
            )}
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span">{getCity(order)}</Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <BlockStack gap="050" inlineAlign="start">
            {rawDeliveryDate !== "—" ? (
              <Text as="span" fontWeight="semibold">
                {deliveryDateDisplay}
              </Text>
            ) : (
              <Text as="span" tone="subdued">
                {deliveryDateDisplay}
              </Text>
            )}
            {deliveryRelative &&
              (deliveryOverdue ? (
                <Badge tone="critical">{deliveryRelative}</Badge>
              ) : (
                <Badge>{deliveryRelative}</Badge>
              ))}
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          {timeWindowValue === "—" ? (
            <Text as="span" tone="subdued">
              {timeWindowValue}
            </Text>
          ) : (
            <Text as="span">{timeWindowValue}</Text>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Badge tone={polarisBadgeTone(financialStatusTone(order.displayFinancialStatus))}>
            {formatStatusLabel(order.displayFinancialStatus)}
          </Badge>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Badge tone={polarisBadgeTone(ffBadge.tone)}>{ffBadge.label}</Badge>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" alignment="end" numeric>
            {total}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          {meaningfulTags.length === 0 ? (
            <Text as="span" tone="subdued">
              —
            </Text>
          ) : (
            <InlineStack gap="100" blockAlign="center" wrap={false}>
              {shownTags.map((tag) => (
                <Badge key={tag}>{tagDisplayLabel(tag)}</Badge>
              ))}
              {extraTags > 0 && (
                // Stop the click so the row's open-panel handler doesn't also fire.
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
                <span onClick={(e) => e.stopPropagation()}>
                  <Button variant="plain" onClick={() => onShowTags(order.id)}>
                    {`+${extraTags}`}
                  </Button>
                </span>
              )}
            </InlineStack>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <>
      {/* View tabs — deliberately NOT IndexFilters' tabs prop: Polaris Tabs
          measures its container to decide which tabs fit and collapses the
          rest into a "More views" disclosure, and inside the embedded-admin
          iframe that measurement was observed to race (containerWidth read
          while unlaid-out), leaving every non-selected tab in the disclosure
          while the visible labels were non-interactive — clicks did nothing,
          so a selected view (e.g. ?tab=unpaid) could never be left (2026-07-11
          smoke round 2, the "phantom tab=unpaid"). Plain buttons have no
          measurement step, so tab switching is deterministic. */}
      <Box paddingInline="200" paddingBlockStart="200" paddingBlockEnd="100">
        <InlineStack gap="100" wrap>
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant="tertiary"
              pressed={tab.id === activeTab}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label}
            </Button>
          ))}
        </InlineStack>
      </Box>
      <IndexFilters
        tabs={[]}
        selected={0}
        onSelect={() => {}}
        canCreateNewView={false}
        queryValue={queryValue}
        queryPlaceholder="Search by order, customer, phone, city"
        onQueryChange={onQueryChange}
        onQueryClear={onQueryClear}
        sortOptions={SORT_OPTIONS}
        sortSelected={[sortSelected]}
        onSort={(values) => {
          if (values[0]) onSortChange(values[0]);
        }}
        filters={filters}
        appliedFilters={appliedFilters}
        onClearAll={onClearFilters}
        // Cancel exits filtering mode WITHOUT calling onQueryClear (Polaris
        // only invokes cancelAction.onAction) — a no-op here left the
        // committed ?search= applied with no visible search box, so the list
        // stayed filtered with no way back (2026-07-12 smoke test, S13).
        cancelAction={{ onAction: onQueryClear }}
        mode={mode}
        setMode={setMode}
        // Sticky mode uses an IntersectionObserver + position:fixed band that
        // misfires inside the embedded-admin iframe — the invisible fixed bar
        // sat over the view-tabs row and swallowed its clicks (2026-07-11
        // smoke round 2 investigation).
        disableStickyMode
      />
      <IndexTable
        resourceName={{ singular: "order", plural: "orders" }}
        itemCount={orders.length}
        selectedItemsCount={
          allResourcesSelected ? "All" : selectedResources.length
        }
        onSelectionChange={onSelectionChange}
        headings={[
          { title: "Order" },
          { title: "Items" },
          { title: "Customer" },
          { title: "City" },
          { title: "Delivery date" },
          { title: "Time window" },
          { title: "Payment" },
          { title: "Fulfillment" },
          { title: "Total", alignment: "end" },
          { title: "Tags" },
        ]}
        promotedBulkActions={promotedBulkActions}
        bulkActions={bulkActions}
        loading={loading}
        emptyState={emptyStateMarkup}
        pagination={{
          hasNext: hasNextPage,
          hasPrevious: hasPreviousPage,
          onNext: onNextPage,
          onPrevious: onPreviousPage,
        }}
      >
        {rowMarkup}
      </IndexTable>
    </>
  );
}
