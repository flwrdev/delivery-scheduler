import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loader/action tests only — the Polaris/App Bridge UI is stubbed out (this
// suite runs in plain node, no jsdom) and shopify.server is fully mocked (its
// Prisma session storage cannot initialize inside vitest).

const { prismaMock, adminMock, graphqlMock, componentStub, getProfileMock, setProfileMock } =
  vi.hoisted(() => ({
    prismaMock: {
      messengerThread: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
    adminMock: vi.fn(),
    graphqlMock: vi.fn(),
    componentStub: () => null,
    getProfileMock: vi.fn(),
    setProfileMock: vi.fn(),
  }));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: adminMock },
}));
// Fully mocked: the real module does outbound Graph fetches (phase 8).
vi.mock("../app/services/messenger-profile.server", () => ({
  getMessengerProfile: getProfileMock,
  setMessengerProfile: setProfileMock,
}));

vi.mock("@shopify/polaris", () => ({
  Badge: componentStub,
  Banner: componentStub,
  BlockStack: componentStub,
  Button: componentStub,
  Card: componentStub,
  EmptyState: componentStub,
  IndexTable: Object.assign(componentStub, { Row: componentStub, Cell: componentStub }),
  InlineStack: componentStub,
  Layout: Object.assign(componentStub, { Section: componentStub }),
  Link: componentStub,
  Page: componentStub,
  Text: componentStub,
}));
vi.mock("@shopify/app-bridge-react", () => ({
  TitleBar: componentStub,
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
}));

import { action, loader } from "../app/routes/app.messenger-orders";

const ROUTE_URL = "https://app.example.com/app/messenger-orders";

function makeActionRequest(fields: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function graphqlJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  adminMock.mockResolvedValue({
    session: { shop: "flowercart.myshopify.com" },
    admin: { graphql: graphqlMock },
  });
  graphqlMock.mockResolvedValue(graphqlJson({ data: { orders: { nodes: [] } } }));
  getProfileMock.mockResolvedValue({
    ok: true,
    profile: { hasGetStarted: true, hasIceBreakers: true, hasPersistentMenu: true },
  });
  setProfileMock.mockResolvedValue({ ok: true });
  prismaMock.messengerThread.findMany.mockResolvedValue([]);
  prismaMock.messengerThread.update.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("app.messenger-orders loader", () => {
  it("requires admin auth and returns thread rows with ISO timestamps", async () => {
    prismaMock.messengerThread.findMany.mockResolvedValue([
      {
        psid: "24680",
        lastCustomerAt: new Date("2026-08-02T03:00:00Z"),
        humanControl: true,
        humanControlAt: new Date("2026-08-02T04:00:00Z"),
      },
      {
        psid: "13579",
        lastCustomerAt: null,
        humanControl: false,
        humanControlAt: null,
      },
    ]);

    const result = await loader({ request: new Request(ROUTE_URL) } as never);

    expect(adminMock).toHaveBeenCalledTimes(1);
    expect(result.threads).toEqual([
      {
        psid: "24680",
        lastCustomerAt: "2026-08-02T03:00:00.000Z",
        humanControl: true,
        humanControlAt: "2026-08-02T04:00:00.000Z",
      },
      {
        psid: "13579",
        lastCustomerAt: null,
        humanControl: false,
        humanControlAt: null,
      },
    ]);

    // Conversation-only page: reads Neon thread flags, never message bodies.
    const findArgs = prismaMock.messengerThread.findMany.mock.calls[0][0];
    expect(findArgs.select).toEqual({
      psid: true,
      lastCustomerAt: true,
      humanControl: true,
      humanControlAt: true,
    });
  });
});

describe("app.messenger-orders action", () => {
  it("pause: sets humanControl=true and starts the handback window", async () => {
    const result = await action({
      request: makeActionRequest({ intent: "pause", psid: "24680" }),
    } as never);

    expect(result).toMatchObject({ ok: true, intent: "pause", psid: "24680" });
    expect(adminMock).toHaveBeenCalledTimes(1);
    const updateArgs = prismaMock.messengerThread.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ psid: "24680" });
    expect(updateArgs.data.humanControl).toBe(true);
    expect(updateArgs.data.humanControlAt).toBeInstanceOf(Date);
  });

  it("resume: clears humanControl AND resets disclosedBot (bot must re-disclose)", async () => {
    const result = await action({
      request: makeActionRequest({ intent: "resume", psid: "24680" }),
    } as never);

    expect(result).toMatchObject({ ok: true, intent: "resume" });
    expect(prismaMock.messengerThread.update).toHaveBeenCalledWith({
      where: { psid: "24680" },
      data: { humanControl: false, humanControlAt: null, disclosedBot: false },
    });
  });

  it("rejects a missing psid without touching the database", async () => {
    const result = await action({
      request: makeActionRequest({ intent: "pause" }),
    } as never);
    expect(result.ok).toBe(false);
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown intent without touching the database", async () => {
    const result = await action({
      request: makeActionRequest({ intent: "delete", psid: "24680" }),
    } as never);
    expect(result.ok).toBe(false);
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled();
  });

  it("answers ok:false (never a thrown 5xx — ADR-11) when the update fails", async () => {
    prismaMock.messengerThread.update.mockRejectedValue(new Error("db down"));
    const result = await action({
      request: makeActionRequest({ intent: "pause", psid: "24680" }),
    } as never);
    expect(result.ok).toBe(false);
    expect(Array.isArray((result as { errors?: string[] }).errors)).toBe(true);
  });
});

describe("app.messenger-orders loader — Shopify orders listing (phase 8, READ-ONLY)", () => {
  it("queries tag:messenger orders and maps rows with Delivery Date/Time customAttributes + admin deep link", async () => {
    graphqlMock.mockResolvedValue(
      graphqlJson({
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/3979001",
                name: "#3979",
                createdAt: "2026-08-02T10:00:00Z",
                displayFinancialStatus: "PAID",
                currentTotalPriceSet: {
                  shopMoney: { amount: "899.00", currencyCode: "PHP" },
                },
                customer: { displayName: "Juan Dela Cruz" },
                shippingAddress: { name: "Maria Clara" },
                customAttributes: [
                  { key: "Delivery Date", value: "2026-08-03" },
                  { key: "Delivery Time", value: "3PM-6PM" },
                ],
              },
              {
                id: "gid://shopify/Order/3980002",
                name: "#3980",
                createdAt: "2026-08-01T09:00:00Z",
                displayFinancialStatus: "PENDING",
                currentTotalPriceSet: null,
                customer: null,
                shippingAddress: { name: "Recipient Lang" },
                customAttributes: [],
              },
            ],
          },
        },
      }),
    );

    const result = await loader({ request: new Request(ROUTE_URL) } as never);

    // Read-only query: first 25, tag:messenger, newest first.
    const [query, options] = graphqlMock.mock.calls[0];
    expect(query).toContain("orders(");
    expect(query).toContain("sortKey: CREATED_AT");
    expect(query).toContain("reverse: true");
    expect(options.variables).toEqual({ first: 25, query: "tag:messenger" });
    expect(query).not.toContain("mutation");

    expect(result.ordersError).toBeNull();
    expect(result.orders).toEqual([
      {
        id: "gid://shopify/Order/3979001",
        name: "#3979",
        createdAt: "2026-08-02T10:00:00Z",
        financialStatus: "PAID",
        total: "₱899.00",
        customerName: "Juan Dela Cruz",
        deliveryDate: "2026-08-03",
        deliveryTime: "3PM-6PM",
        adminUrl: "shopify://admin/orders/3979001",
      },
      {
        id: "gid://shopify/Order/3980002",
        name: "#3980",
        createdAt: "2026-08-01T09:00:00Z",
        financialStatus: "PENDING",
        total: "",
        customerName: "Recipient Lang",
        deliveryDate: "",
        deliveryTime: "",
        adminUrl: "shopify://admin/orders/3980002",
      },
    ]);
  });

  it("degrades to ordersError (threads intact, no crash) when the GraphQL call throws", async () => {
    graphqlMock.mockRejectedValue(new Error("upstream 502"));
    prismaMock.messengerThread.findMany.mockResolvedValue([
      { psid: "24680", lastCustomerAt: null, humanControl: false, humanControlAt: null },
    ]);

    const result = await loader({ request: new Request(ROUTE_URL) } as never);

    expect(result.orders).toEqual([]);
    expect(typeof result.ordersError).toBe("string");
    expect(result.threads).toHaveLength(1);
  });

  it("degrades to ordersError when the GraphQL body carries errors", async () => {
    graphqlMock.mockResolvedValue(graphqlJson({ errors: [{ message: "Throttled" }] }));
    const result = await loader({ request: new Request(ROUTE_URL) } as never);
    expect(result.orders).toEqual([]);
    expect(result.ordersError).not.toBeNull();
  });

  it("reports the Messenger profile status from the loader (set / not_set / unknown)", async () => {
    let result = await loader({ request: new Request(ROUTE_URL) } as never);
    expect(result.profileStatus).toBe("set");

    getProfileMock.mockResolvedValue({
      ok: true,
      profile: { hasGetStarted: true, hasIceBreakers: false, hasPersistentMenu: true },
    });
    result = await loader({ request: new Request(ROUTE_URL) } as never);
    expect(result.profileStatus).toBe("not_set");

    // Best-effort: a profile read failure is "unknown", never a crash.
    getProfileMock.mockResolvedValue({ ok: false, error: "Graph API 400: nope" });
    result = await loader({ request: new Request(ROUTE_URL) } as never);
    expect(result.profileStatus).toBe("unknown");
  });
});

describe("app.messenger-orders action — setupProfile (phase 8)", () => {
  it("sets the Messenger profile and answers ok:true", async () => {
    const result = await action({
      request: makeActionRequest({ intent: "setupProfile" }),
    } as never);
    expect(result).toMatchObject({ ok: true, intent: "setupProfile" });
    expect(setProfileMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.messengerThread.update).not.toHaveBeenCalled();
  });

  it("answers ok:false + errors (ADR-11, 200 body) when the profile POST fails upstream", async () => {
    setProfileMock.mockResolvedValue({ ok: false, error: "Graph API 400: bad token" });
    const result = await action({
      request: makeActionRequest({ intent: "setupProfile" }),
    } as never);
    expect(result.ok).toBe(false);
    expect((result as { errors?: string[] }).errors).toEqual(["Graph API 400: bad token"]);
  });
});
