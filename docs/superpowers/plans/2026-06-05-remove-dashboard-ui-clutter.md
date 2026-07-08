# Remove Dashboard UI Clutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three unused UI blocks from the orders dashboard — the header/banner bar, the Sort button + menu, and the Columns toggle button + modal — along with all their associated state, handlers, and CSS.

**Architecture:** Pure deletion. No new code. Remove JSX blocks, dead state variables, dead handlers, dead computed values, dead types/constants, and the CSS that styled the removed elements. The `exportForLalamove` function stays because the selection bar still uses it.

**Tech Stack:** React (TSX), plain CSS

---

## Files Modified

| File | What changes |
|------|-------------|
| `app/routes/app.orders.tsx` | Delete Sort + Columns + Header JSX, state, handlers, types, constants |
| `app/styles/orders-dashboard.css` | Delete `.ods-header-bar` / `.ods-subtitle` / `.ods-header-btns` CSS block, remove `#modal-columns` from modal size rule, remove `.ods-header-btns` from print rule |

---

## Task 1: Remove Sort feature — types, constants, component

**Files:**
- Modify: `app/routes/app.orders.tsx:53-274`

- [ ] **Step 1: Delete sort-related types and FULFILLMENT_ORDER constant**

  Find and delete lines 53-69 exactly (3 types + 1 constant):
  ```tsx
  // DELETE these 4 blocks:
  type SortableColumn = "city" | "timeWindow" | "deliveryDate" | "fulfillment";
  type SortDirection = "asc" | "desc";

  interface SortState {
    column: SortableColumn | null;
    direction: SortDirection;
  }

  const FULFILLMENT_ORDER: Record<string, number> = {
    UNFULFILLED: 0,
    ON_HOLD: 1,
    SCHEDULED: 2,
    IN_PROGRESS: 3,
    PARTIALLY_FULFILLED: 4,
    FULFILLED: 5,
    RESTOCKED: 6,
  };
  ```

- [ ] **Step 2: Delete SortableHeaderProps interface, TableListSlot type, and SortableHeader component**

  Find and delete lines 236-274:
  ```tsx
  // DELETE the entire block from:
  interface SortableHeaderProps {
  // ...to and including the closing brace of:
  function SortableHeader(...) { ... }
  ```

- [ ] **Step 3: Verify TypeScript still compiles (no TS errors from the removed types)**

  Run: `npx tsc --noEmit`
  Expected: Errors only about remaining usages of removed identifiers (those will be fixed in Task 2).

---

## Task 2: Remove Sort feature — state, handlers, computed values, JSX

**Files:**
- Modify: `app/routes/app.orders.tsx:1337-2895`

- [ ] **Step 1: Delete sortState useState**

  Find and delete (around line 1337):
  ```tsx
  // DELETE:
  const [sortState, setSortState] = useState<SortState>({
    column: null,
    direction: "asc",
  });
  ```

- [ ] **Step 2: Delete handleSort callback**

  Find and delete (around line 1472):
  ```tsx
  // DELETE:
  const handleSort = useCallback((col: SortableColumn): void => {
    setSortState((prev) => ({
      column: col,
      direction:
        prev.column === col && prev.direction === "asc" ? "desc" : "asc",
    }));
  }, []);
  ```

- [ ] **Step 3: Remove setSortState line from handleClearFilters**

  In `handleClearFilters` (around line 1514), find and delete the single line:
  ```tsx
  // DELETE this one line:
  setSortState({ column: null, direction: "asc" });
  ```

- [ ] **Step 4: Simplify displayedOrders — remove sort logic**

  Replace the entire `useMemo` block (around line 1584):
  ```tsx
  // OLD — DELETE this entire block:
  const displayedOrders: Order[] = useMemo(() => {
    if (!sortState.column) return filteredOrders;
    return [...filteredOrders].sort((a, b) => {
      let cmp = 0;
      switch (sortState.column) {
        case "timeWindow": { ... }
        case "deliveryDate": { ... }
        case "fulfillment": { ... }
        case "city": { ... }
      }
      return sortState.direction === "asc" ? cmp : -cmp;
    });
  }, [filteredOrders, sortState]);
  ```

  Replace with:
  ```tsx
  const displayedOrders: Order[] = filteredOrders;
  ```

- [ ] **Step 5: Delete sortLabel const and fix hasActiveViewControls**

  Find (around line 1976) and delete `sortLabel`:
  ```tsx
  // DELETE:
  const sortLabel: string = sortState.column
    ? `${sortState.column === "timeWindow" ? "Time window" : ...} ${...}`
    : "Sort";
  ```

  Then update `hasActiveViewControls` (the very next meaningful line after tabDefs):
  ```tsx
  // OLD:
  const hasActiveViewControls = Boolean(hasActiveFilters || sortState.column);

  // NEW:
  const hasActiveViewControls = hasActiveFilters;
  ```

- [ ] **Step 6: Delete the sort-menu JSX block**

  Find and delete the entire `<s-menu id="sort-menu">` element (around line 2008):
  ```tsx
  // DELETE from <s-menu id="sort-menu" ...> to the matching </s-menu>
  // Approximately lines 2008-2077
  ```

- [ ] **Step 7: Delete the Sort button from the toolbar**

  In the `ods-toolbar-actions` div (around line 2888), find and delete:
  ```tsx
  // DELETE:
  <s-button
    variant="secondary"
    icon={sortState.column ? "sort-ascending" : "sort"}
    commandFor="sort-menu"
    accessibilityLabel="Sort orders"
  >
    {sortLabel}
  </s-button>
  ```

- [ ] **Step 8: Replace SortableHeader usages in table headers with plain s-table-header**

  Find these 4 blocks in the table header row (around lines 2937-2980) and replace each:

  ```tsx
  // OLD:
  {visibleColumns.has("city") && (
    <SortableHeader
      id="header-city"
      column="city"
      label="City"
      sortState={sortState}
      onSort={handleSort}
      listSlot="labeled"
    />
  )}
  // NEW (keep the visibleColumns wrapper for now — Task 3 removes it):
  {visibleColumns.has("city") && (
    <s-table-header id="header-city" listSlot="labeled">City</s-table-header>
  )}
  ```

  ```tsx
  // OLD:
  {visibleColumns.has("deliveryDate") && (
    <SortableHeader
      id="header-delivery-date"
      column="deliveryDate"
      label="Delivery date"
      sortState={sortState}
      onSort={handleSort}
      listSlot="labeled"
    />
  )}
  // NEW:
  {visibleColumns.has("deliveryDate") && (
    <s-table-header id="header-delivery-date" listSlot="labeled">Delivery date</s-table-header>
  )}
  ```

  ```tsx
  // OLD:
  {visibleColumns.has("timeWindow") && (
    <SortableHeader
      id="header-time-window"
      column="timeWindow"
      label="Time window"
      sortState={sortState}
      onSort={handleSort}
      listSlot="labeled"
    />
  )}
  // NEW:
  {visibleColumns.has("timeWindow") && (
    <s-table-header id="header-time-window" listSlot="labeled">Time window</s-table-header>
  )}
  ```

  ```tsx
  // OLD:
  {visibleColumns.has("fulfillment") && (
    <SortableHeader
      id="header-fulfillment"
      column="fulfillment"
      label="Fulfillment"
      sortState={sortState}
      onSort={handleSort}
      listSlot="labeled"
    />
  )}
  // NEW:
  {visibleColumns.has("fulfillment") && (
    <s-table-header id="header-fulfillment" listSlot="labeled">Fulfillment</s-table-header>
  )}
  ```

- [ ] **Step 9: Verify TypeScript has no sort-related errors remaining**

  Run: `npx tsc --noEmit`
  Expected: No errors referencing `sortState`, `handleSort`, `sortLabel`, `SortableHeader`, `SortableColumn`, `SortDirection`, `SortState`, or `FULFILLMENT_ORDER`.

---

## Task 3: Remove Columns feature — constants, state, handlers, JSX

**Files:**
- Modify: `app/routes/app.orders.tsx:71-3332`

- [ ] **Step 1: Delete DEFAULT_VISIBLE_COLUMNS and MOBILE_VISIBLE_COLUMNS constants**

  Find and delete lines 71-91:
  ```tsx
  // DELETE:
  const DEFAULT_VISIBLE_COLUMNS = [
    "name", "items", "customer", "city",
    "payment", "fulfillment", "deliveryDate", "timeWindow", "total",
  ];

  const MOBILE_VISIBLE_COLUMNS = [
    "name", "customer", "city", "deliveryDate", "timeWindow", "fulfillment",
  ];
  ```

- [ ] **Step 2: Delete visibleColumns state**

  Find and delete (around line 1354):
  ```tsx
  // DELETE:
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    new Set(DEFAULT_VISIBLE_COLUMNS),
  );
  ```

- [ ] **Step 3: Delete handleToggleColumn handler**

  Find and delete (around line 1455):
  ```tsx
  // DELETE:
  const handleToggleColumn = (colId: string, checked: boolean) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (checked) next.add(colId);
      else next.delete(colId);
      return next;
    });
  };
  ```

- [ ] **Step 4: Delete the mobile resize useEffect**

  Find and delete (around line 1371):
  ```tsx
  // DELETE this entire useEffect:
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const handleResize = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setVisibleColumns(new Set(MOBILE_VISIBLE_COLUMNS));
      } else {
        setVisibleColumns(new Set(DEFAULT_VISIBLE_COLUMNS));
      }
    };
    handleResize(mediaQuery);
    mediaQuery.addEventListener("change", handleResize);
    return () => mediaQuery.removeEventListener("change", handleResize);
  }, []);
  ```

- [ ] **Step 5: Delete the modal-columns JSX block**

  Find and delete the entire `<s-modal id="modal-columns">` element (around lines 2080-2208):
  ```tsx
  // DELETE from:
  {/* Columns config modal */}
  <s-modal id="modal-columns" heading="Configure Table Columns" size="large">
  // ...to and including the matching </s-modal>
  ```

- [ ] **Step 6: Delete the Columns button from the toolbar**

  In the `ods-toolbar-actions` div (right after the Reset button, around line 2896), find and delete:
  ```tsx
  // DELETE:
  <s-button
    variant="secondary"
    commandFor="modal-columns"
    accessibilityLabel="Configure columns"
  >
    Columns
  </s-button>
  ```

- [ ] **Step 7: Remove visibleColumns.has wrappers from table headers**

  In the `<s-table-header-row>` block (around lines 2921-2991), unwrap each conditional. The checkbox header has no wrapper — leave it alone. For every other header, remove the outer `{visibleColumns.has("X") && (...)}` wrapper and keep just the inner element:

  ```tsx
  // OLD pattern:
  {visibleColumns.has("name") && (
    <s-table-header id="header-order" listSlot="primary">
      Order
    </s-table-header>
  )}

  // NEW pattern (just the inner element, no conditional):
  <s-table-header id="header-order" listSlot="primary">
    Order
  </s-table-header>
  ```

  Apply to all 9 column headers: `name`, `items`, `customer`, `city`, `deliveryDate`, `timeWindow`, `payment`, `fulfillment`, `total`, `tags`.

- [ ] **Step 8: Remove visibleColumns.has wrappers from table body rows**

  In the `displayedOrders.map(...)` callback (around lines 3078-3332), for each column cell that is wrapped in `{visibleColumns.has("X") && (...)}`, remove the wrapper and keep the inner `<s-table-cell>`:

  Columns to unwrap: `name`, `items`, `customer`, `city`, `deliveryDate`, `timeWindow`, `payment`, `fulfillment`, `total`, `tags`.

  ```tsx
  // OLD:
  {visibleColumns.has("city") && (
    <s-table-cell id={`cell-city-${orderId}`}>
      <s-text>{getCity(order)}</s-text>
    </s-table-cell>
  )}

  // NEW:
  <s-table-cell id={`cell-city-${orderId}`}>
    <s-text>{getCity(order)}</s-text>
  </s-table-cell>
  ```

- [ ] **Step 9: Verify TypeScript — no columns-related errors**

  Run: `npx tsc --noEmit`
  Expected: No errors referencing `visibleColumns`, `setVisibleColumns`, `handleToggleColumn`, `DEFAULT_VISIBLE_COLUMNS`, or `MOBILE_VISIBLE_COLUMNS`.

---

## Task 4: Remove Header bar

**Files:**
- Modify: `app/routes/app.orders.tsx:1425-2670`

- [ ] **Step 1: Delete subtitleDate useMemo**

  Find and delete (around line 1425):
  ```tsx
  // DELETE:
  const subtitleDate = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );
  ```

- [ ] **Step 2: Delete the ods-header-bar JSX block**

  Find and delete the entire div (around lines 2645-2670):
  ```tsx
  // DELETE:
  {/* ── Header actions bar ───────────────────────────────────────────────── */}
  <div className="ods-header-bar">
    <p className="ods-subtitle">
      Plan, prep, and dispatch deliveries for {subtitleDate}.
    </p>
    <div className="ods-header-btns">
      <s-button
        variant="secondary"
        icon="print"
        onClick={() => window.print()}
      >
        Print picklist
      </s-button>
      {selectedCount === 0 && (
        <s-button
          variant="secondary"
          icon="export"
          onClick={exportForLalamove}
        >
          Export
        </s-button>
      )}
      <s-button variant="primary" href="shopify://admin/orders/new">
        Create order
      </s-button>
    </div>
  </div>
  ```

- [ ] **Step 3: Verify TypeScript — no header-related errors**

  Run: `npx tsc --noEmit`
  Expected: No errors for `subtitleDate`.

---

## Task 5: CSS cleanup

**Files:**
- Modify: `app/styles/orders-dashboard.css:10-54, 976-992`

- [ ] **Step 1: Remove #modal-columns from the modal size rule**

  Find (around line 10):
  ```css
  /* OLD: */
  #modal-columns,
  #modal-cancel-orders,
  ```

  Replace with:
  ```css
  /* NEW (remove the first line): */
  #modal-cancel-orders,
  ```

- [ ] **Step 2: Delete the entire header bar CSS block**

  Find and delete lines 22-54 (from the comment through the `@media (max-width: 520px)` block):
  ```css
  /* DELETE from: */
  /* ── Header actions bar ────────────────────────────────────────────────── */
  .ods-header-bar { ... }
  .ods-subtitle { ... }
  .ods-header-btns { ... }
  @media (max-width: 520px) {
    .ods-header-bar { ... }
    .ods-header-btns,
    .ods-header-btns > s-button { ... }
  }
  /* ...to end of that @media block (line 54) */
  ```

- [ ] **Step 3: Remove .ods-header-btns from the print media rule**

  In the `@media print` block (around line 976), find and delete the single line:
  ```css
  /* DELETE this one line: */
  .ods-header-btns,
  ```

  The surrounding block should remain intact:
  ```css
  @media print {
    .ods-backdrop,
    .ods-drawer,
    /* .ods-header-btns,  ← deleted */
    .ods-selection-bar,
    ...
  }
  ```

- [ ] **Step 4: Commit all changes**

  ```bash
  git add app/routes/app.orders.tsx app/styles/orders-dashboard.css
  git commit -m "perf: remove Sort, Columns, and header bar from orders dashboard"
  ```

---

## Self-Review

**Spec coverage:**
- ✅ "Plan, prep, and dispatch deliveries" banner — removed in Task 4
- ✅ "Print picklist, Export, Create order" buttons — removed in Task 4
- ✅ Sort button + sort menu — removed in Task 2
- ✅ Columns button + columns modal — removed in Task 3
- ✅ CSS for all removed elements — cleaned in Task 5
- ✅ Dead state/handlers/types for removed features — cleaned in Tasks 1-4

**Dead code NOT removed (intentional):**
- `exportForLalamove` function — still used by the "Export for Lalamove" button inside the selection bar
- `window.print()` CSS (`@media print` block itself) — kept for potential future use; only `.ods-header-btns` line removed

**No placeholder text detected.**

**Type consistency check:** All removed identifiers (`sortState`, `visibleColumns`, `handleSort`, `handleToggleColumn`, `SortableHeader`, `SortableColumn`, `FULFILLMENT_ORDER`, `DEFAULT_VISIBLE_COLUMNS`, `MOBILE_VISIBLE_COLUMNS`, `subtitleDate`) are self-contained and not referenced after Task 5.
