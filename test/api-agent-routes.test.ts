import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { graphqlMock, adminMock, findCodFeeVariantMock } = vi.hoisted(() => ({
  graphqlMock: vi.fn(),
  adminMock: vi.fn(),
  findCodFeeVariantMock: vi.fn(),
}));
adminMock.mockImplementation(async () => ({ admin: { graphql: graphqlMock } }));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
}));

vi.mock("../app/services/schedule-rules.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/schedule-rules.server")>();
  const { DEFAULT_DELIVERY_SCHEDULE_RULES } = await import("../app/lib/delivery-availability");
  return { ...actual, getScheduleRulesWithBookedCounts: vi.fn(async () => DEFAULT_DELIVERY_SCHEDULE_RULES) };
});

vi.mock("../app/services/cod-fee.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/services/cod-fee.server")>();
  return { ...actual, findCodFeeVariant: findCodFeeVariantMock };
});

import { addDays, getShopLocalDate } from "../app/lib/delivery-availability";
import { resetAgentRateLimits } from "../app/lib/verify-agent-token.server";
import { action as draftAction } from "../app/routes/api.agent.orders.draft";
import { loader as statusLoader } from "../app/routes/api.agent.orders.status";
import { loader as quoteLoader } from "../app/routes/api.agent.delivery.quote";

const TOKEN = "agent-test-token";
const BASE = "https://app.example.com";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(path: string, token: string | null = TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, { headers });
}

const futureDate = addDays(getShopLocalDate(), 3);

function validDraftBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "conv-abc-1",
    customer: { email: "Buyer@Example.com", firstName: "Ana" },
    recipient: { name: "Maria Santos", phone: "09171234567", address1: "12 Sample St", city: "Makati", zip: "1200" },
    items: [{ productHandle: "autumn-morning", quantity: 1 }],
    delivery: { date: futureDate, timeSlot: "9AM-12PM", cardMessage: "Happy birthday" },
    deliveryFee: 160,
    paymentMode: "invoice",
    channel: { psid: "100000493184591" },
    ...overrides,
  };
}

type Call = { query: string; variables: Record<string, unknown> };
function calls(): Call[] {
  return graphqlMock.mock.calls.map(([query, opts]) => ({
    query: String(query),
    variables: (opts as { variables?: Record<string, unknown> } | undefined)?.variables ?? {},
  }));
}

function routeGraphql(options: { existingDraft?: unknown; product?: unknown; created?: unknown; completed?: unknown; order?: unknown } = {}) {
  graphqlMock.mockImplementation(async (query: string) => {
    if (query.includes("AgentDraftByTag")) {
      return jsonResponse({ data: { draftOrders: { nodes: options.existingDraft ? [options.existingDraft] : [] } } });
    }
    if (query.includes("AgentProductSearch")) {
      return jsonResponse({
        data: {
          products: {
            nodes: [
              options.product ?? {
                id: "gid://shopify/Product/1",
                title: "Autumn Morning",
                handle: "autumn-morning",
                status: "ACTIVE",
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", title: "Default Title", price: "799.00", availableForSale: true }] },
              },
            ],
          },
        },
      });
    }
    if (query.includes("AgentCodConfig")) {
      return jsonResponse({
        data: {
          paymentCustomizations: {
            nodes: [{ title: "Cash on Delivery", metafield: { jsonValue: { feeAmount: 70, minimumAmount: 0, maximumAmount: 2500 } } }],
          },
        },
      });
    }
    if (query.includes("AgentDraftCreate")) {
      return jsonResponse({
        data: {
          draftOrderCreate: {
            draftOrder: options.created ?? {
              id: "gid://shopify/DraftOrder/500",
              name: "#D500",
              status: "OPEN",
              invoiceUrl: "https://shop.example.com/invoices/abc",
              totalPriceSet: { shopMoney: { amount: "959.00" } },
            },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes("AgentDraftComplete")) {
      return jsonResponse({
        data: {
          draftOrderComplete: {
            draftOrder: { id: "gid://shopify/DraftOrder/500", name: "#D500", order: options.completed ?? { id: "gid://shopify/Order/900", name: "#4400" } },
            userErrors: [],
          },
        },
      });
    }
    if (query.includes("TrackOrder")) {
      return jsonResponse({ data: { orders: { nodes: options.order ? [options.order] : [] } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  });
}

beforeEach(() => {
  vi.stubEnv("META_AGENT_API_TOKEN", TOKEN);
  vi.stubEnv("SHOP_DOMAIN", "flowercart-dev.myshopify.com");
  findCodFeeVariantMock.mockResolvedValue({
    variant: { id: "gid://shopify/ProductVariant/77", sku: "COD-FEE", price: "70.00", productId: "gid://shopify/Product/7" },
    errors: [],
  });
});

afterEach(() => {
  graphqlMock.mockReset();
  adminMock.mockClear();
  findCodFeeVariantMock.mockReset();
  resetAgentRateLimits();
  vi.unstubAllEnvs();
});

describe("POST /api/agent/orders/draft", () => {
  it("rejects a missing token with 401 and never touches Shopify", async () => {
    const response = await draftAction({ request: post("/api/agent/orders/draft", validDraftBody(), null), params: {}, context: {} } as never);
    expect(response.status).toBe(401);
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("returns 422 with the field list when required input is missing", async () => {
    const response = await draftAction({
      request: post("/api/agent/orders/draft", { idempotencyKey: "x", items: [] }),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; fields: string[] } };
    expect(body.error.code).toBe("validation");
    expect(body.error.fields).toEqual(expect.arrayContaining(["idempotencyKey", "customer.email", "recipient.name", "items", "delivery.date"]));
    expect(adminMock).not.toHaveBeenCalled();
  });

  it("creates a draft with delivery attributes, tags, PSID, and returns the invoice URL", async () => {
    routeGraphql();
    const response = await draftAction({ request: post("/api/agent/orders/draft", validDraftBody()), params: {}, context: {} } as never);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      reused: false,
      mode: "draft",
      draftName: "#D500",
      invoiceUrl: "https://shop.example.com/invoices/abc",
      total: 959,
      delivery: { date: futureDate, timeSlot: "9AM-12PM" },
    });
    expect((body.summary as { items: unknown[] }).items).toEqual([{ title: "Autumn Morning", quantity: 1, price: 799 }]);

    const create = calls().find((c) => c.query.includes("AgentDraftCreate"));
    const input = create?.variables.input as Record<string, unknown>;
    expect(input.email).toBe("buyer@example.com");
    expect(input.lineItems).toEqual([{ variantId: "gid://shopify/ProductVariant/11", quantity: 1 }]);
    expect(input.tags).toEqual([futureDate, "9AM-12PM", "source:messenger", "agent-key-conv-abc-1"]);
    expect(input.customAttributes).toEqual(
      expect.arrayContaining([
        { key: "Delivery Date", value: futureDate },
        { key: "Delivery Time", value: "9AM-12PM" },
        { key: "Card Message", value: "Happy birthday" },
        { key: "_Messenger PSID", value: "100000493184591" },
      ]),
    );
    expect(input.shippingLine).toEqual({ title: "LALAMOVE", priceWithCurrency: { amount: 160, currencyCode: "PHP" } });
    expect((input.shippingAddress as Record<string, unknown>).city).toBe("Makati");
    expect(calls().some((c) => c.query.includes("AgentDraftComplete"))).toBe(false);
  });

  it("returns the existing draft for a repeated idempotency key without creating another", async () => {
    routeGraphql({
      existingDraft: {
        id: "gid://shopify/DraftOrder/1",
        name: "#D1",
        status: "OPEN",
        invoiceUrl: "https://shop.example.com/invoices/old",
        totalPriceSet: { shopMoney: { amount: "959.00" } },
        order: null,
      },
    });
    const response = await draftAction({ request: post("/api/agent/orders/draft", validDraftBody()), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reused: true, mode: "draft", draftName: "#D1", invoiceUrl: "https://shop.example.com/invoices/old" });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("rejects a date outside the booking window with the schedule code and available slots", async () => {
    routeGraphql();
    const response = await draftAction({
      request: post("/api/agent/orders/draft", validDraftBody({ delivery: { date: "2020-01-01", timeSlot: "9AM-12PM" } })),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; availableSlots: string[]; minDate: string } };
    expect(body.error.code).toBe("date_before_min");
    expect(Array.isArray(body.error.availableSlots)).toBe(true);
    expect(body.error.minDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });

  it("completes a COD order with the COD-FEE line and paymentPending", async () => {
    routeGraphql();
    const response = await draftAction({
      request: post("/api/agent/orders/draft", validDraftBody({ paymentMode: "cod", idempotencyKey: "conv-cod-1" })),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, mode: "order", orderName: "#4400", statusPageUrl: "https://flowercart.store/pages/track?order=4400" });
    expect((body.summary as { codFee: number }).codFee).toBe(70);

    const create = calls().find((c) => c.query.includes("AgentDraftCreate"));
    const input = create?.variables.input as { lineItems: unknown[]; tags: string[] };
    expect(input.lineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/11", quantity: 1 },
      { variantId: "gid://shopify/ProductVariant/77", quantity: 1 },
    ]);
    expect(input.tags).toContain("cod");
    const complete = calls().find((c) => c.query.includes("AgentDraftComplete"));
    expect(complete?.variables).toMatchObject({ id: "gid://shopify/DraftOrder/500", paymentPending: true });
  });

  it("refuses COD outside Metro Manila before creating anything", async () => {
    routeGraphql();
    const response = await draftAction({
      request: post(
        "/api/agent/orders/draft",
        validDraftBody({ paymentMode: "cod", recipient: { name: "Juan", address1: "Road 1", city: "Imus", zip: "4103" } }),
      ),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "cod_not_available" } });
    expect(calls().some((c) => c.query.includes("AgentDraftCreate"))).toBe(false);
  });
});

describe("GET /api/agent/orders/status", () => {
  it("returns 404 when the order number and email do not match", async () => {
    routeGraphql({ order: null });
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=4220&email=x@y.com"), params: {}, context: {} } as never);
    expect(response.status).toBe(404);
  });

  it("returns the stage, links, and a Taglish message for a matching order", async () => {
    routeGraphql({
      order: {
        name: "#4220",
        email: "x@y.com",
        phone: null,
        cancelledAt: null,
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "UNFULFILLED",
        customAttributes: [
          { key: "Delivery Date", value: futureDate },
          { key: "Delivery Time", value: "3PM-6PM" },
        ],
        shippingAddress: { phone: null },
        fulfillments: [],
        lineItems: { nodes: [{ title: "Autumn Morning", quantity: 1 }] },
      },
    });
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=%234220&email=X@y.com"), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      orderName: "#4220",
      stage: "confirmed",
      delivery: { date: futureDate, timeSlot: "3PM-6PM" },
      statusPageUrl: "https://flowercart.store/pages/track?order=4220",
      canReschedule: true,
      reschedulePageUrl: "https://flowercart.store/account",
      message: expect.stringContaining("#4220"),
    });
  });

  it("requires an email", async () => {
    const response = await statusLoader({ request: get("/api/agent/orders/status?order=4220"), params: {}, context: {} } as never);
    expect(response.status).toBe(422);
  });
});

describe("GET /api/agent/delivery/quote", () => {
  it("quotes a covered Metro Manila city with COD availability and slots", async () => {
    routeGraphql();
    const response = await quoteLoader({ request: get(`/api/agent/delivery/quote?city=Makati&date=${futureDate}`), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, covered: true, freeShippingAbovePhp: 2500, cod: { availableInArea: true, feeAmount: 70, maximumAmount: 2500 } });
    expect(typeof body.feeMin).toBe("number");
    expect(body.slots).toEqual(["9AM-12PM", "12PM-3PM", "3PM-6PM", "6PM-11PM"]);
    expect((body.date as { valid: boolean; availableSlots: string[] }).valid).toBe(true);
  });

  it("marks a provincial town as covered but not COD-eligible", async () => {
    routeGraphql();
    const response = await quoteLoader({ request: get("/api/agent/delivery/quote?city=Imus"), params: {}, context: {} } as never);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, covered: true, cod: { availableInArea: false } });
    expect(body.provincialNote).toBeTruthy();
  });

  it("returns 422 without a city or zip", async () => {
    const response = await quoteLoader({ request: get("/api/agent/delivery/quote"), params: {}, context: {} } as never);
    expect(response.status).toBe(422);
  });
});
