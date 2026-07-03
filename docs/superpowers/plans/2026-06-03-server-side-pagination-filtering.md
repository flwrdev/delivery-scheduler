# Server-Side Pagination & Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `searchTerm` and `timeWindowFilter` from client-side array filtering to Shopify GraphQL query parameters, and fix cursor-based pagination so it works consistently for all filter combinations.

**Architecture:** All filter state (search, timeWindow, tab, deliveryDate) lives in the URL as search params. The loader reads these params, builds a composite Shopify GraphQL `query` string, and always fetches 25 orders with cursor pagination. The client-side `filteredOrders` useMemo is simplified to only handle `thisWeek` tab (which requires a date-range filter Shopify cannot express on metafields) and client-side sort remains unchanged.

**Tech Stack:** React Router (loader + navigate), Shopify Admin GraphQL (`orders` query with `query:` string), TypeScript, React hooks (useState, useEffect, useMemo, useRef)

---

## File Structure

| File | Role |
|------|------|
| `app/routes/app.orders.tsx` | Only file changed. Touches: `LoaderData` type, `loader` function, `Extension` component state/handlers/render. |

---

## Shopify Query Syntax Reference

The Shopify Admin API `orders` query accepts a `query:` string with these filter tokens:

| Intent | Shopify query token |
|--------|---------------------|
| Text search (name, customer, email, phone) | raw text e.g. `"john"` |
| Delivery date (metafield) | `metafields.custom.date:2026-06-03` |
| Time slot (metafield) | `metafields.custom.time_slot:9AM-12PM` |
| Unfulfilled orders | `fulfillment_status:unfulfilled` |
| Unpaid orders | `financial_status:pending OR financial_status:authorized OR financial_status:partially_paid` |
| Today's orders | `metafields.custom.date:TODAYISO` |
| Tomorrow's orders | `metafields.custom.date:TOMORROWISO` |

Multiple tokens are combined with a space (= AND). Tokens with spaces internally must be wrapped in quotes if Shopify requires it — test with the delivery date and time slot values as-is first.

`thisWeek` tab has no Shopify equivalent (range query on metafield is unsupported) — it continues as a client-side filter over the fetched page.

---

## Task 1: Extend `LoaderData` type and loader to accept new URL params

**Files:**
- Modify: `app/routes/app.orders.tsx:290-344`

- [ ] **Step 1: Extend `LoaderData` type**

Replace the existing `LoaderData` type (lines ~290-295):

```typescript
type LoaderData = {
  orders: Order[];
  pageInfo: PageInfo | null;
  errors: Array<{ message: string }> | null;
  deliveryDateParam: string | null;
  searchParam: string;
  timeWindowParam: string;
  tabParam: string;
};
```

- [ ] **Step 2: Update loader to read new params and build composite query**

Replace the entire `loader` function body (lines ~297-344):

```typescript
export const loader = async ({
  request,
}: {
  request: Request;
}): Promise<Response> => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const rawDeliveryDateParam = url.searchParams.get("deliveryDate");
  const deliveryDateParam = isIsoDateParam(rawDeliveryDateParam)
    ? rawDeliveryDateParam
    : null;

  const searchParam = url.searchParams.get("search")?.trim() ?? "";
  const timeWindowParam = url.searchParams.get("timeWindow")?.trim() ?? "";
  const tabParam = url.searchParams.get("tab") ?? "all";

  const after = url.searchParams.get("after") || null;
  const before = url.searchParams.get("before") || null;

  // Build composite Shopify query string
  const queryParts: string[] = [];

  if (deliveryDateParam) {
    queryParts.push(`metafields.custom.date:${deliveryDateParam}`);
  }
  if (searchParam) {
    queryParts.push(searchParam);
  }
  if (timeWindowParam) {
    queryParts.push(`metafields.custom.time_slot:${timeWindowParam}`);
  }
  if (tabParam === "unfulfilled") {
    queryParts.push("fulfillment_status:unfulfilled");
  } else if (tabParam === "unpaid") {
    queryParts.push(
      "financial_status:pending OR financial_status:authorized OR financial_status:partially_paid",
    );
  } else if (tabParam === "today") {
    const todayISO = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
    queryParts.push(`metafields.custom.date:${todayISO}`);
  } else if (tabParam === "tomorrow") {
    const tom = new Date();
    tom.setDate(tom.getDate() + 1);
    const tomorrowISO = tom.toLocaleDateString("en-CA");
    queryParts.push(`metafields.custom.date:${tomorrowISO}`);
  }
  // "thisWeek" and "all" tabs: no server-side query fragment; client filters thisWeek

  const compositeQuery = queryParts.join(" ") || null;

  // thisWeek tab fetches more orders because client must filter by date range
  const pageSize = tabParam === "thisWeek" ? 250 : 25;

  const variables = {
    first: before ? null : pageSize,
    after,
    last: before ? pageSize : null,
    before,
    query: compositeQuery,
  };

  const response = await admin.graphql(GET_ORDERS_QUERY, { variables });
  const body = (await response.json()) as {
    data?: {
      orders?: {
        edges?: Array<{ node: Order }>;
        pageInfo?: PageInfo | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  return Response.json(
    {
      orders:
        body.data?.orders?.edges?.map((edge: { node: Order }) => edge.node) ??
        [],
      pageInfo: body.data?.orders?.pageInfo ?? null,
      errors: body.errors ?? null,
      deliveryDateParam,
      searchParam,
      timeWindowParam,
      tabParam,
    } satisfies LoaderData,
    { headers: { "Cache-Control": "no-store" } },
  );
};
```

- [ ] **Step 3: TypeScript check — expect no errors**

```powershell
npx tsc --noEmit 2>&1 | Select-String "app.orders"
```

Expected: no output (no errors).

- [ ] **Step 4: Commit**

```powershell
git add app/routes/app.orders.tsx
git commit -m "feat: extend loader to accept search/timeWindow/tab URL params for server-side filtering"
```

---

## Task 2: Replace client-side `searchTerm` + `timeWindowFilter` state with URL-derived values

**Files:**
- Modify: `app/routes/app.orders.tsx` — Extension component state and handlers

- [ ] **Step 1: Add `searchParam`/`timeWindowParam`/`tabParam` reads from loaderData, add debounce ref**

In the `Extension` component, after the `loaderData` destructuring (around line 965-975), replace the state declarations and add the URL-backed values:

Keep the existing `loaderData` reads, then add:

```typescript
const searchParam = loaderData.searchParam;
const timeWindowParam = loaderData.timeWindowParam;
const tabParam = loaderData.tabParam as ActiveTab;
```

Find and REPLACE these two state declarations (around lines 984-985):
```typescript
const [searchTerm, setSearchTerm] = useState<string>("");
const [timeWindowFilter, setTimeWindowFilter] = useState<string>("");
```
With:
```typescript
// Local draft for the search input — debounced to URL via useEffect below
const [searchTerm, setSearchTerm] = useState<string>(searchParam);
const searchParamRef = useRef(searchParam);
```

Find and REPLACE the `activeTab` state declaration (around line 988):
```typescript
const [activeTab, setActiveTab] = useState<ActiveTab>("all");
```
With:
```typescript
// activeTab is URL-driven; local state removed — use tabParam from loader
```
(Delete the `activeTab` line entirely; we'll replace all usages with `tabParam`.)

- [ ] **Step 2: Add search debounce useEffect**

After the existing `useEffect(() => { setSelectedIds(new Set()); }, [activeTab])` block (around line 1034-1036), ADD this new effect:

```typescript
// Debounce search input to URL param
useEffect(() => {
  if (searchTerm === searchParamRef.current) return;
  const timer = setTimeout(() => {
    searchParamRef.current = searchTerm;
    const params = new URLSearchParams(searchParams);
    if (searchTerm.trim()) {
      params.set("search", searchTerm.trim());
    } else {
      params.delete("search");
    }
    params.delete("after");
    params.delete("before");
    navigate(`?${params.toString()}`, { replace: true });
  }, 300);
  return () => clearTimeout(timer);
}, [searchTerm, searchParams, navigate]);
```

Also ADD an effect to sync the draft when the loader returns a new `searchParam` (e.g., user navigates back):

```typescript
useEffect(() => {
  searchParamRef.current = searchParam;
  setSearchTerm(searchParam);
}, [searchParam]);
```

- [ ] **Step 3: Update `handleSearchInput`**

Find (around line 1089-1091):
```typescript
const handleSearchInput = (e: Event): void => {
  setSearchTerm(getSafeEventValue(e));
};
```

This stays the same — `setSearchTerm` still updates local draft; the debounce effect handles navigation.

- [ ] **Step 4: Add `handleTabChange` helper that navigates to `?tab=VALUE` and clears cursors**

After `handleSearchInput` (around line 1091), ADD:

```typescript
const handleTabChange = useCallback(
  (tab: ActiveTab): void => {
    const params = new URLSearchParams(searchParams);
    if (tab === "all") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    params.delete("after");
    params.delete("before");
    setSelectedIds(new Set());
    navigate(`?${params.toString()}`, { replace: true });
  },
  [searchParams, navigate],
);
```

- [ ] **Step 5: Update `timeWindowFilter` change handler in JSX**

Find the `s-select` for time slot (around line 2520-2527):
```typescript
onChange={(e: Event) => {
  setTimeWindowFilter(getSafeEventValue(e));
  setSelectedIds(new Set());
}}
```

Replace with:
```typescript
onChange={(e: Event) => {
  const val = getSafeEventValue(e);
  const params = new URLSearchParams(searchParams);
  if (val) {
    params.set("timeWindow", val);
  } else {
    params.delete("timeWindow");
  }
  params.delete("after");
  params.delete("before");
  setSelectedIds(new Set());
  navigate(`?${params.toString()}`, { replace: true });
}}
```

- [ ] **Step 6: Update `handleClearFilters` to clear all URL params**

Find (around line 1117-1124):
```typescript
const handleClearFilters = (): void => {
  setSearchTerm("");
  setTimeWindowFilter("");
  setSelectedIds(new Set());
  setActiveTab("all");
  setSortState({ column: null, direction: "asc" });
  navigate("?", { replace: true });
};
```

Replace with:
```typescript
const handleClearFilters = (): void => {
  setSearchTerm("");
  setSelectedIds(new Set());
  setSortState({ column: null, direction: "asc" });
  navigate("?", { replace: true });
};
```

- [ ] **Step 7: Update `handleDateChange` to also clear tab/search/timeWindow and cursors**

Find (around line 1105-1115):
```typescript
const handleDateChange = (value: string): void => {
  const iso = normalizeDateToISO(value);
  const params = new URLSearchParams(searchParams);
  if (iso) {
    params.set("deliveryDate", iso);
  } else {
    params.delete("deliveryDate");
  }
  setSelectedIds(new Set());
  navigate(`?${params.toString()}`, { replace: true });
};
```

Replace with:
```typescript
const handleDateChange = (value: string): void => {
  const iso = normalizeDateToISO(value);
  const params = new URLSearchParams(searchParams);
  if (iso) {
    params.set("deliveryDate", iso);
  } else {
    params.delete("deliveryDate");
  }
  params.delete("after");
  params.delete("before");
  setSelectedIds(new Set());
  navigate(`?${params.toString()}`, { replace: true });
};
```

- [ ] **Step 8: Replace all `setActiveTab(...)` call sites with `handleTabChange(...)`**

Search for every `setActiveTab(` in the file. There are 4-5 occurrences:
- `setActiveTab("all")` in `handleClearFilters` — already removed in Step 6
- `setActiveTab("unpaid")` in KPI card click (line ~2368 and 2372)
- `setActiveTab("unfulfilled")` in KPI card click (line ~2392 and 2396)
- `setActiveTab(tab.id)` in tab render (line ~2429)
- `setActiveTab("all")` in the `useEffect` for `activeTab` change

For each call site, replace `setActiveTab(X)` with `handleTabChange(X)`.

Also find and DELETE the old `useEffect(() => { setSelectedIds(new Set()); }, [activeTab])` — cursor-clearing and selection-clearing is now handled inside `handleTabChange`.

- [ ] **Step 9: TypeScript check**

```powershell
npx tsc --noEmit 2>&1 | Select-String "app.orders"
```

Expected: errors for any remaining `timeWindowFilter` or `activeTab` variable references. Fix by replacing:
- `timeWindowFilter` → `timeWindowParam`
- `activeTab` → `tabParam`

- [ ] **Step 10: Commit**

```powershell
git add app/routes/app.orders.tsx
git commit -m "feat: move searchTerm and timeWindowFilter to URL params with debounced navigation"
```

---

## Task 3: Simplify client-side `filteredOrders` to only handle `thisWeek` tab

**Files:**
- Modify: `app/routes/app.orders.tsx` — `filteredOrders` useMemo

- [ ] **Step 1: Replace `filteredOrders` useMemo**

Find the existing `filteredOrders` useMemo (around lines 1169-1215). Replace the entire block with:

```typescript
// Server handles all filters except thisWeek (date-range on metafield not supported server-side)
const filteredOrders: Order[] = useMemo(() => {
  if (tabParam !== "thisWeek") return orders;
  return orders.filter((order) => {
    const d = getDeliveryDateValue(order);
    return (
      d !== "—" &&
      d >= dateRefs.startWeekISO &&
      d <= dateRefs.endWeekISO
    );
  });
}, [orders, tabParam, dateRefs]);
```

- [ ] **Step 2: Update `hasActiveFilters` to use URL params**

Find (around line 1635-1640):
```typescript
const hasActiveFilters = Boolean(
  searchTerm.trim() ||
  timeWindowFilter ||
  deliveryDateFilter ||
  activeTab !== "all",
);
```

Replace with:
```typescript
const hasActiveFilters = Boolean(
  searchParam ||
  timeWindowParam ||
  deliveryDateFilter ||
  tabParam !== "all",
);
```

- [ ] **Step 3: Update `tabCounts` to use `tabParam` not `activeTab`**

Find the `tabCounts` useMemo (around line 1382). The computation references `orders` and `dateRefs` — no change needed there. But if it references `activeTab`, replace with `tabParam`.

- [ ] **Step 4: Update `tabDefs` array to use `tabParam`**

Find (around line 1627-1633):
```typescript
const tabDefs: { id: ActiveTab; label: string; count: number }[] = [
  { id: "all", label: "All", count: orders.length },
  ...
];
```

No structural change needed — `tabCounts` still works. Only the tab render needs to use `tabParam` for the `aria-selected` and `className` checks.

- [ ] **Step 5: Update tab render to use `tabParam`**

Find (around line 2422-2434) the tab render:
```typescript
<button
  ...
  aria-selected={activeTab === tab.id}
  className={`ods-tab${activeTab === tab.id ? " ods-tab--active" : ""}`}
  onClick={() => setActiveTab(tab.id)}
>
```

Replace with:
```typescript
<button
  ...
  aria-selected={tabParam === tab.id}
  className={`ods-tab${tabParam === tab.id ? " ods-tab--active" : ""}`}
  onClick={() => handleTabChange(tab.id)}
>
```

- [ ] **Step 6: Update the s-select for time slot value to use `timeWindowParam`**

Find (around line 2523):
```typescript
value={timeWindowFilter}
```
Replace with:
```typescript
value={timeWindowParam}
```

- [ ] **Step 7: TypeScript check — expect zero errors**

```powershell
npx tsc --noEmit 2>&1 | Select-String "app.orders"
```

Expected: no output.

- [ ] **Step 8: Commit**

```powershell
git add app/routes/app.orders.tsx
git commit -m "refactor: simplify client-side filteredOrders — server handles all filters except thisWeek tab"
```

---

## Task 4: Ensure cursor pagination works for all filter combos (pagination handlers + empty-state text)

**Files:**
- Modify: `app/routes/app.orders.tsx` — pagination handlers and empty-state text

- [ ] **Step 1: Verify `handleNextPage` / `handlePreviousPage` preserve filter params**

Find the handlers (around lines 1151-1165):
```typescript
const handleNextPage = (): void => {
  if (!pageInfo?.hasNextPage || !pageInfo.endCursor) return;
  const params = new URLSearchParams(searchParams);
  params.set("after", pageInfo.endCursor);
  params.delete("before");
  navigate(`?${params.toString()}`, { replace: true });
};

const handlePreviousPage = (): void => {
  if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) return;
  const params = new URLSearchParams(searchParams);
  params.set("before", pageInfo.startCursor);
  params.delete("after");
  navigate(`?${params.toString()}`, { replace: true });
};
```

These already preserve other params (`search`, `timeWindow`, `tab`, `deliveryDate`) because they spread from `new URLSearchParams(searchParams)`. No change needed.

- [ ] **Step 2: Update empty-state message to reference server-side filters**

Find (around line 2667) the empty state message:
```typescript
"A search, tab, delivery date, or time slot filter may be active. Use Reset to see all loaded orders."
```

Replace with:
```typescript
"No orders match the current filters. Use Reset to clear all filters."
```

- [ ] **Step 3: TypeScript check**

```powershell
npx tsc --noEmit 2>&1 | Select-String "app.orders"
```

Expected: no output.

- [ ] **Step 4: Commit**

```powershell
git add app/routes/app.orders.tsx
git commit -m "fix: verify pagination handlers preserve filter params; update empty-state text"
```

---

## Task 5: Final smoke test

- [ ] **Step 1: Start the dev server**

```powershell
npm run dev
```

- [ ] **Step 2: Test each filter combination**

Open the Orders page and test:

| Test | Expected |
|------|----------|
| Type in search field (wait 300ms) | URL gains `?search=VALUE`; table reloads with Shopify text-filtered orders |
| Select a time slot | URL gains `?timeWindow=9AM-12PM`; table reloads with only that time slot's orders |
| Click "Today" tab | URL gains `?tab=today`; table shows today's delivery date orders |
| Click "Unfulfilled" tab | URL gains `?tab=unfulfilled`; table shows only unfulfilled orders |
| Click "This Week" tab | URL gains `?tab=thisWeek`; table fetches 250 and client-filters by week |
| Click Next Page | URL gains `?after=CURSOR`; loads next 25 orders; filter params preserved |
| Click Previous Page | URL gains `?before=CURSOR`; loads previous 25 orders |
| Click Reset | URL becomes `?`; all filters cleared; all state reset |
| Set delivery date filter | URL gains `?deliveryDate=VALUE`; loads 25 matching orders (not 250) |

- [ ] **Step 3: Verify no TypeScript errors remain**

```powershell
npx tsc --noEmit 2>&1
```

Expected: no errors (only the usual npm shamefully-hoist warning is OK).

- [ ] **Step 4: Final commit (if any remaining tweaks)**

```powershell
git add app/routes/app.orders.tsx
git commit -m "feat: server-side pagination and filtering — search, timeWindow, tab via URL params"
```

---

## Known Limitations (Acceptable)

| Limitation | Reason | Mitigation |
|-----------|--------|------------|
| `thisWeek` tab fetches 250 orders (not paginated) | Shopify metafield range query unsupported | Acceptable since a week has bounded orders; shown in empty-state |
| Search via Shopify text search ≠ full custom-attribute search | Shopify API limitation | Shopify text search covers order name, customer name, email, phone, address |
| Time slot filter only matches `custom.time_slot` metafield (not legacy `customAttributes`) | Shopify API limitation | New orders all use the metafield path |
| Tab count badges show counts of current page only (not total across all pages) | Pagination limitation | Counts reflect visible orders; label clearly says "Tab" |
| KPI cards show stats for current page only | Pagination limitation | Most useful when date filter is active (one day's orders fit in 25) |
