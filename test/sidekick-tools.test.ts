import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level tests for the three READ-ONLY Sidekick tool endpoints.
// `shopify.server` is fully mocked (its Prisma session storage cannot
// initialize inside vitest) and so are the two rules loaders, so these tests
// assert the ROUTE contract: always HTTP 200, `{ok:true|false}` bodies
// (ADR-11), honest input validation, and — the load-bearing one — that no
// mutation ever reaches Admin GraphQL.

const { authenticateAdminMock, graphqlMock, corsMock, getDetailedMock, getWithHealthMock } =
  vi.hoisted(() => ({
    authenticateAdminMock: vi.fn(),
    graphqlMock: vi.fn(),
    corsMock: vi.fn((response: Response) => response),
    getDetailedMock: vi.fn(),
    getWithHealthMock: vi.fn(),
  }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdminMock },
}));
vi.mock("../app/services/schedule-rules.server", () => ({
  getScheduleRulesDetailed: getDetailedMock,
  getScheduleRulesWithHealth: getWithHealthMock,
}));

import { action as bookedCountsAction } from "../app/routes/sidekick.tools.booked-counts";
import { action as orderDeliveryAction } from "../app/routes/sidekick.tools.order-delivery";
import { action as scheduleConfigAction } from "../app/routes/sidekick.tools.schedule-config";

const SHOP = "flowercart-dev.myshopify.com";

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

/** React Router hands loaders/actions a params/context bag we never read. */
function run(
  routeAction: (args: {
    request: Request;
    params: Record<string, string>;
    context: Record<string, never>;
  }) => Promise<Response>,
  request: Request,
) {
  return routeAction({ request, params: {}, context: {} });
}

function graphqlResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const RULES = {
  timezone: "Asia/Manila",
  cutoffHour: 17,
  prepHours: 1,
  maxDays: 25,
  slots: [
    { display: "9AM-12PM", value: "9AM-12PM" },
    { display: "12PM-3PM", value: "12PM-3PM" },
  ],
  disabledDates: ["2026-08-25"],
  disabledSlots: { "2026-08-21": ["12PM-3PM"] },
  slotCapacity: {
    "2026-08-20": {
      "9AM-12PM": { capacity: 10, booked: 4 },
      "12PM-3PM": { capacity: 8, booked: 8 },
    },
    "2026-08-21": { "9AM-12PM": { capacity: 6, booked: 1 } },
    "2026-08-25": { "9AM-12PM": { capacity: 5, booked: 0 } },
  },
};

function detailed(
  overrides: Partial<{
    countsMeta: Record<string, unknown>;
    rules: typeof RULES;
  }> = {},
) {
  return {
    rules: overrides.rules ?? RULES,
    configHealth: [],
    version: 7,
    countsMeta: overrides.countsMeta ?? {
      status: "ok",
      fetchedAt: "2026-08-19T02:00:00.000Z",
      fromCache: false,
    },
  };
}

const ORDER_NODE = {
  id: "gid://shopify/Order/5678901234567",
  name: "#4111",
  createdAt: "2026-08-18T01:00:00Z",
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  displayFinancialStatus: "PAID",
  customAttributes: [
    { key: "Delivery Date", value: "2026-08-20" },
    { key: "Delivery Time", value: "9AM-12PM" },
  ],
  customDate: { value: "2026-08-20" },
  customTimeSlot: { value: "9AM-12PM" },
  legacyDate: { value: "2026-08-20" },
  legacyTimeSlot: { value: "9AM-12PM" },
  syncStatus: { value: "ok" },
  rescheduleStatus: { value: "requested" },
  rescheduleRequestedAt: { value: "2026-08-18T05:00:00Z" },
  rescheduleHistory: { jsonValue: [{ source: "customer" }, { source: "merchant" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  authenticateAdminMock.mockResolvedValue({
    admin: { graphql: graphqlMock },
    session: { shop: SHOP },
    cors: corsMock,
  });
  getDetailedMock.mockResolvedValue(detailed());
  getWithHealthMock.mockResolvedValue({
    rules: RULES,
    configHealth: [],
    version: 7,
  });
  graphqlMock.mockResolvedValue(
    graphqlResponse({ data: { orders: { nodes: [ORDER_NODE] } } }),
  );
});

describe("POST /sidekick/tools/booked-counts", () => {
  it("returns per-date, per-slot booked-vs-capacity with countsMeta.status surfaced", async () => {
    // Pin "now" so the default today-forward window is deterministic.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {}),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.timezone).toBe("Asia/Manila");
    expect(body.countsStatus).toBe("ok");
    expect(body.countsNote).toMatch(/live/i);
    // Default window is today forward — every seeded date is in the future.
    expect(body.dates.map((d: { date: string }) => d.date)).toEqual([
      "2026-08-20",
      "2026-08-21",
      "2026-08-25",
    ]);

    const first = body.dates[0];
    expect(first.slots).toEqual([
      {
        slot: "9AM-12PM",
        capacity: 10,
        booked: 4,
        remaining: 6,
        full: false,
        blocked: false,
      },
      {
        slot: "12PM-3PM",
        capacity: 8,
        booked: 8,
        remaining: 0,
        full: true,
        blocked: false,
      },
    ]);
    expect(body.dates[1].slots[0].blocked).toBe(false);
    expect(body.dates[2].dateDisabled).toBe(true);
    expect(body.today).toBe("2026-08-19");
    expect(body.capacityTrackedDates).toBe(3);
    expect(body.datesOmitted).toBe(0);
    expect(corsMock).toHaveBeenCalled();
    // L-11c: the session's shop is what scopes the rules lookup.
    expect(getDetailedMock).toHaveBeenCalledWith(SHOP, { graphql: graphqlMock });
  });

  it("only reaches back into the past when an explicit range asks for it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));

    const upcoming = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {}),
      )
    ).json();
    expect(upcoming.dates.map((d: { date: string }) => d.date)).toEqual([
      "2026-08-25",
    ]);

    const backfill = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {
          start_date: "2026-08-20",
          end_date: "2026-08-21",
        }),
      )
    ).json();
    expect(backfill.dates.map((d: { date: string }) => d.date)).toEqual([
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(backfill.datesMatched).toBe(2);
  });

  it("narrows to a single requested date", async () => {
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {
        date: "2026-08-21",
      }),
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.dates).toHaveLength(1);
    expect(body.dates[0].date).toBe("2026-08-21");
    expect(body.dates[0].slots[0].blocked).toBe(false);
  });

  it("surfaces a partial scan as a lower bound rather than reporting ok", async () => {
    getDetailedMock.mockResolvedValue(
      detailed({
        countsMeta: {
          status: "partial",
          fetchedAt: null,
          fromCache: true,
          truncation: { caps: ["pages"], affectedDates: ["2026-08-20"] },
        },
      }),
    );

    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {}),
    );
    const body = await response.json();
    expect(body.countsStatus).toBe("partial");
    expect(body.countsNote).toMatch(/LOWER BOUND/);
    expect(body.truncatedDates).toEqual(["2026-08-20"]);
  });

  it("rejects a malformed date with 200 + ok:false and a helpful message", async () => {
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {
        date: "next friday",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/YYYY-MM-DD/);
    expect(getDetailedMock).not.toHaveBeenCalled();
  });

  it("rejects a reversed range with 200 + ok:false", async () => {
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {
        start_date: "2026-08-25",
        end_date: "2026-08-20",
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(false);
  });

  it("nulls out booked/remaining/full when the counts scan errored (M-2)", async () => {
    getDetailedMock.mockResolvedValue(
      detailed({
        countsMeta: { status: "error", fetchedAt: null, fromCache: false },
      }),
    );

    const body = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {
          date: "2026-08-20",
        }),
      )
    ).json();

    expect(body.ok).toBe(true);
    expect(body.countsStatus).toBe("error");
    expect(body.countsNote).toMatch(/unavailable/i);
    // Capacity is config and stays real; the scan-derived numbers must not be
    // presented as zero bookings on a possibly-full day.
    expect(body.dates[0].slots).toEqual([
      {
        slot: "9AM-12PM",
        capacity: 10,
        booked: null,
        remaining: null,
        full: null,
        blocked: false,
      },
      {
        slot: "12PM-3PM",
        capacity: 8,
        booked: null,
        remaining: null,
        full: null,
        blocked: false,
      },
    ]);
  });

  it("nulls out the same numbers when the scan was skipped (M-2)", async () => {
    getDetailedMock.mockResolvedValue(
      detailed({
        countsMeta: { status: "skipped", fetchedAt: null, fromCache: false },
      }),
    );

    const body = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {
          date: "2026-08-20",
        }),
      )
    ).json();

    expect(body.dates[0].slots[0].booked).toBeNull();
    expect(body.dates[0].slots[0].capacity).toBe(10);
  });

  it("flags a requested date that has no capacity configured (L-12)", async () => {
    const body = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {
          date: "2026-09-09",
        }),
      )
    ).json();

    expect(body.ok).toBe(true);
    expect(body.dates).toEqual([]);
    expect(body.untrackedRequestedDates).toEqual(["2026-09-09"]);
  });

  it("does not flag untracked dates when none were explicitly requested", async () => {
    const body = await (
      await run(
        bookedCountsAction,
        post("https://app.test/sidekick/tools/booked-counts", {}),
      )
    ).json();
    expect(body.untrackedRequestedDates).toBeUndefined();
  });

  it("applies the cors helper on an ERROR path too (L-11b)", async () => {
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {
        date: "not a date",
      }),
    );

    expect((await response.json()).ok).toBe(false);
    expect(corsMock).toHaveBeenCalledTimes(1);
    expect(corsMock.mock.results[0].value).toBe(response);
  });

  it("answers 200 + ok:false when the rules loader throws (ADR-11)", async () => {
    getDetailedMock.mockRejectedValue(new Error("Neon cold start timed out"));
    const response = await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {}),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

describe("POST /sidekick/tools/schedule-config", () => {
  it("returns the config summary without asking for booked counts", async () => {
    const response = await run(
      scheduleConfigAction,
      post("https://app.test/sidekick/tools/schedule-config", {}),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body).toMatchObject({
      timezone: "Asia/Manila",
      cutoffHour: 17,
      prepHours: 1,
      maxDays: 25,
      slotCount: 2,
      disabledDatesCount: 1,
      blockedSlotDatesCount: 1,
      capacityTrackedDatesCount: 3,
      version: 7,
    });
    expect(getWithHealthMock).toHaveBeenCalledWith(SHOP);
    expect(body.disabledDatesSample).toEqual(["2026-08-25"]);
    expect(body.blockedSlotsSample).toEqual([
      { date: "2026-08-21", slots: ["12PM-3PM"] },
    ]);
    // The cheap tool: never triggers the live Admin order scan.
    expect(getDetailedMock).not.toHaveBeenCalled();
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 200 + ok:false", async () => {
    const request = new Request("https://app.test/sidekick/tools/schedule-config", {
      method: "POST",
      body: "not json at all",
    });
    const response = await run(scheduleConfigAction, request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/JSON/);
  });

  it("answers 200 + ok:false when the config loader throws (ADR-11)", async () => {
    getWithHealthMock.mockRejectedValue(new Error("prisma down"));
    const response = await run(
      scheduleConfigAction,
      post("https://app.test/sidekick/tools/schedule-config", {}),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(false);
  });
});

describe("POST /sidekick/tools/order-delivery", () => {
  it("returns one order's delivery schedule and a deep link", async () => {
    const response = await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: "4111",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.order).toMatchObject({
      name: "#4111",
      legacyId: "5678901234567",
      deliveryDate: "2026-08-20",
      deliveryTimeSlot: "9AM-12PM",
      deliverySource: "metafield",
      deliverySyncStatus: "ok",
      rescheduleStatus: "requested",
      rescheduleCount: 2,
      displayFulfillmentStatus: "UNFULFILLED",
    });
    expect(body.order.appUrl).toBe(
      "/app/orders?order=5678901234567&search=%234111",
    );

    // A bare number is normalised into Shopify's `name:` term.
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(graphqlMock.mock.calls[0][1]).toEqual({
      variables: { query: 'name:"#4111"' },
    });
  });

  it("passes a hashed order number through unchanged", async () => {
    await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: " #4111 ",
      }),
    );
    expect(graphqlMock.mock.calls[0][1]).toEqual({
      variables: { query: 'name:"#4111"' },
    });
  });

  it("falls back to custom attributes when the metafields are empty", async () => {
    graphqlMock.mockResolvedValue(
      graphqlResponse({
        data: {
          orders: {
            nodes: [
              {
                ...ORDER_NODE,
                customDate: null,
                customTimeSlot: null,
                legacyDate: null,
                legacyTimeSlot: null,
                rescheduleHistory: null,
              },
            ],
          },
        },
      }),
    );

    const body = await (
      await run(
        orderDeliveryAction,
        post("https://app.test/sidekick/tools/order-delivery", {
          order_name: "4111",
        }),
      )
    ).json();

    expect(body.ok).toBe(true);
    expect(body.order.deliverySource).toBe("custom_attribute");
    expect(body.order.deliveryDate).toBe("2026-08-20");
    expect(body.order.rescheduleCount).toBe(0);
  });

  it("rejects a missing order number with 200 + ok:false and never calls Admin", async () => {
    const response = await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {}),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/order number/i);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("reports a miss as 200 + ok:false rather than an empty order", async () => {
    graphqlMock.mockResolvedValue(
      graphqlResponse({ data: { orders: { nodes: [] } } }),
    );
    const response = await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: "9999",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("#9999");
  });

  it("answers 200 + ok:false when Admin returns GraphQL errors (ADR-11)", async () => {
    graphqlMock.mockResolvedValue(
      graphqlResponse({ errors: [{ message: "Throttled" }] }),
    );
    const response = await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: "4111",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Throttled");
  });

  it("answers 200 + ok:false when the Admin call throws (ADR-11)", async () => {
    graphqlMock.mockRejectedValue(new Error("socket hang up"));
    const response = await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: "4111",
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(false);
  });
});

describe("auth boundary (M-3)", () => {
  it("answers 200 + ok:false when the session store throws a plain Error", async () => {
    authenticateAdminMock.mockRejectedValue(new Error("Neon connection timeout"));

    for (const [label, routeAction, body] of [
      ["booked-counts", bookedCountsAction, {}],
      ["schedule-config", scheduleConfigAction, {}],
      ["order-delivery", orderDeliveryAction, { order_name: "4111" }],
    ] as const) {
      const response = await run(
        routeAction,
        post(`https://app.test/sidekick/tools/${label}`, body),
      );

      expect(response.status, label).toBe(200);
      const json = await response.json();
      expect(json.ok, label).toBe(false);
      expect(json.error, label).toMatch(/session store/i);
      // No cors helper exists on this path, so the headers are set by hand.
      expect(response.headers.get("Access-Control-Allow-Origin"), label).toBe("*");
    }
  });

  it("rethrows a thrown Response untouched — platform auth is control flow", async () => {
    const authResponse = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    authenticateAdminMock.mockRejectedValue(authResponse);

    await expect(
      run(
        scheduleConfigAction,
        post("https://app.test/sidekick/tools/schedule-config", {}),
      ),
    ).rejects.toBe(authResponse);
  });
});

describe("read-only guard", () => {
  it("never sends a mutation to Admin GraphQL from any Sidekick tool route", async () => {
    await run(
      bookedCountsAction,
      post("https://app.test/sidekick/tools/booked-counts", {}),
    );
    await run(
      scheduleConfigAction,
      post("https://app.test/sidekick/tools/schedule-config", {}),
    );
    await run(
      orderDeliveryAction,
      post("https://app.test/sidekick/tools/order-delivery", {
        order_name: "4111",
      }),
    );

    expect(graphqlMock).toHaveBeenCalledTimes(1);
    for (const [document] of graphqlMock.mock.calls) {
      expect(typeof document).toBe("string");
      expect(document).not.toMatch(/\bmutation\b/i);
      expect(document).toMatch(/\bquery\s+SidekickOrderDelivery\b/);
    }
  });

  it("keeps every mutation string out of the route + service sources", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "app/routes/sidekick.tools.booked-counts.ts",
      "app/routes/sidekick.tools.order-delivery.ts",
      "app/routes/sidekick.tools.schedule-config.ts",
      "app/services/sidekick-tools.server.ts",
    ];

    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // Catches `mutation Foo(`, `mutation Foo {` and anonymous `mutation {`.
      expect(source, file).not.toMatch(/\bmutation\s*(?:\w+\s*)?[({]/);
      expect(source, file).not.toMatch(
        /metafieldsSet|orderUpdate|tagsAdd|tagsRemove/,
      );
      expect(source, file).not.toMatch(
        /upsertScheduleRules|rescheduleOrderDelivery|syncOrderDeliveryMetafields|syncOrderDeliveryScheduleTag/,
      );
    }
  });
});
