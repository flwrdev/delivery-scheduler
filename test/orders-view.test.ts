import { describe, expect, it } from "vitest";

import { computeDateRefs } from "../app/lib/date-refs";
import type { Order } from "../app/lib/order-utils";
import {
  DEFAULT_SORT,
  buildOrdersQueryPlan,
  buildOrdersTabDefs,
  computeOrderKpis,
  computeTabCounts,
  findHiddenSearchMatches,
  parseOrdersViewParams,
  selectDisplayedOrders,
} from "../app/lib/orders-view";

const TODAY = "2026-10-07";

function plan(query: string) {
  return buildOrdersQueryPlan(parseOrdersViewParams(new URLSearchParams(query)), TODAY);
}

function order(
  id: string,
  fields: {
    date?: string;
    slot?: string;
    financial?: string;
    fulfillment?: string;
    cancelled?: boolean;
    total?: string;
    shipping?: string;
    items?: Array<[string, number]>;
    tags?: string[];
  } = {},
): Order {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: "2026-10-01T00:00:00Z",
    cancelledAt: fields.cancelled ? "2026-10-02T00:00:00Z" : null,
    displayFinancialStatus: fields.financial ?? "PAID",
    displayFulfillmentStatus: fields.fulfillment ?? "UNFULFILLED",
    tags: fields.tags ?? [],
    customAttributes: [],
    customDate: fields.date ? { value: fields.date } : null,
    customTimeSlot: fields.slot ? { value: fields.slot } : null,
    currentTotalPriceSet: { shopMoney: { amount: fields.total ?? "100.00", currencyCode: "PHP" } },
    totalShippingPriceSet: { shopMoney: { amount: fields.shipping ?? "0.00", currencyCode: "PHP" } },
    lineItems: {
      edges: (fields.items ?? []).map(([name, quantity]) => ({ node: { name, quantity } })),
    },
  } as unknown as Order;
}

describe("parseOrdersViewParams", () => {
  it("defaults the tab and sort and drops an invalid date or sort", () => {
    expect(
      parseOrdersViewParams(new URLSearchParams("deliveryDate=2026-1-5&sort=bogus&search=%20rose%20")),
    ).toEqual({
      deliveryDateParam: null,
      searchParam: "rose",
      timeWindowParam: "",
      tabParam: "all",
      sortParam: DEFAULT_SORT,
      after: null,
      before: null,
    });
  });
});

describe("buildOrdersQueryPlan", () => {
  it("All view: hides archived, 25 rows, newest first", () => {
    expect(plan("")).toEqual({
      variables: {
        first: 25,
        after: null,
        last: null,
        before: null,
        query: "-status:closed",
        reverse: true,
      },
      pageSize: 25,
      dateScoped: false,
    });
  });

  it("quotes a search containing a colon", () => {
    expect(plan("search=status:closed").variables.query).toBe(
      '"status:closed" -status:closed',
    );
  });

  it("status tabs send their status terms", () => {
    expect(plan("tab=unfulfilled").variables.query).toBe(
      "fulfillment_status:unfulfilled status:open",
    );
    expect(plan("tab=unpaid").variables.query).toBe(
      "(financial_status:pending OR financial_status:authorized OR financial_status:partially_paid) status:open",
    );
    expect(plan("tab=archived").variables.query).toBe("status:closed");
  });

  it("dated tabs send the delivery-date tag and load 250 rows", () => {
    expect(plan("tab=today")).toMatchObject({
      variables: { first: 250, query: "-status:closed tag:2026-10-07" },
      pageSize: 250,
      dateScoped: true,
    });
    expect(plan("tab=tomorrow").variables.query).toBe("-status:closed tag:2026-10-08");
    expect(plan("tab=yesterday").variables.query).toBe("-status:closed tag:2026-10-06");
    expect(plan("tab=thisWeek").variables.query).toBe(
      "-status:closed (tag:2026-10-04 OR tag:2026-10-05 OR tag:2026-10-06 OR tag:2026-10-07 OR tag:2026-10-08 OR tag:2026-10-09 OR tag:2026-10-10)",
    );
    expect(plan("tab=lastWeek").variables.query).toBe(
      "-status:closed (tag:2026-09-27 OR tag:2026-09-28 OR tag:2026-09-29 OR tag:2026-09-30 OR tag:2026-10-01 OR tag:2026-10-02 OR tag:2026-10-03)",
    );
  });

  it("date filter adds its tag; a slot filter only enlarges the page", () => {
    expect(plan("deliveryDate=2026-10-20")).toMatchObject({
      variables: { query: "-status:closed tag:2026-10-20" },
      pageSize: 250,
      dateScoped: true,
    });
    expect(plan("timeWindow=9AM-12PM")).toMatchObject({
      variables: { query: "-status:closed" },
      pageSize: 250,
      dateScoped: false,
    });
  });

  it("cursors and the ascending sort map onto the query variables", () => {
    expect(plan("before=abc&sort=orderDate%20asc").variables).toMatchObject({
      first: null,
      last: 25,
      before: "abc",
      reverse: false,
    });
    expect(plan("after=xyz").variables).toMatchObject({ first: 25, after: "xyz" });
  });
});

describe("selectDisplayedOrders", () => {
  const refs = computeDateRefs(TODAY);
  const orders = [
    order("1", { date: "2026-10-07", slot: "9AM-12PM" }),
    order("2", { date: "2026-10-07", slot: "3PM-6PM" }),
    order("3", { date: "2026-10-09" }),
    order("4"),
  ];

  it("filters by tab and slot", () => {
    const ids = selectDisplayedOrders(
      orders,
      { tabParam: "today", deliveryDateFilter: "", timeWindowParam: "3PM-6PM", sortParam: DEFAULT_SORT },
      refs,
    ).map((o) => o.name);
    expect(ids).toEqual(["#2"]);
  });

  it("sorts by delivery date with undated orders last", () => {
    const ids = selectDisplayedOrders(
      orders,
      { tabParam: "all", deliveryDateFilter: "", timeWindowParam: "", sortParam: "deliveryDate desc" },
      refs,
    ).map((o) => o.name);
    expect(ids).toEqual(["#3", "#1", "#2", "#4"]);
  });

  it("names search hits hidden by a dated tab", () => {
    expect(
      findHiddenSearchMatches([orders[2]], 0, {
        searchParam: "3",
        tabParam: "today",
        deliveryDateFilter: "",
        timeWindowParam: "",
      }),
    ).toEqual([{ id: "gid://shopify/Order/3", name: "#3", when: expect.stringContaining("Oct") }]);
  });
});

describe("tab counts and KPIs", () => {
  const refs = computeDateRefs(TODAY);
  const orders = [
    order("1", { date: "2026-10-07", financial: "PENDING", items: [["Roses", 2]], shipping: "150.00" }),
    order("2", { date: "2026-10-06", cancelled: true, items: [["Tulips", 5]] }),
    order("3", { date: "2026-10-08", fulfillment: "FULFILLED", items: [["Roses", 1]] }),
  ];

  it("hides counts on a 25-row page and other tabs on a date-scoped page", () => {
    const tabCounts = computeTabCounts(orders, refs);
    expect(tabCounts).toMatchObject({ today: 1, yesterday: 1, tomorrow: 1, unfulfilled: 1, unpaid: 1 });

    const small = buildOrdersTabDefs({
      orders,
      tabCounts,
      tabParam: "all",
      pageSize: 25,
      dateScoped: false,
      pageInfo: null,
    });
    expect(small.every((t) => t.count === null)).toBe(true);

    const scoped = buildOrdersTabDefs({
      orders,
      tabCounts,
      tabParam: "today",
      pageSize: 250,
      dateScoped: true,
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: null, endCursor: null },
    });
    expect(scoped.filter((t) => t.count !== null).map((t) => [t.id, t.count, t.approximate])).toEqual([
      ["today", 1, true],
    ]);
  });

  it("excludes cancelled orders from unfulfilled and items to prepare", () => {
    const kpis = computeOrderKpis(orders, TODAY);
    expect(kpis.kpiOrderCount).toBe(3);
    expect(kpis.kpiUnpaidCount).toBe(1);
    expect(kpis.kpiUnfulfilledCount).toBe(1);
    expect(kpis.kpiUnfulfilledDueToday).toBe(1);
    expect(kpis.kpiProducts).toEqual([["Roses", 3]]);
  });
});
