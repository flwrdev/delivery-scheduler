import { beforeEach, describe, expect, it, vi } from "vitest";

const { adminAuthMock, listRepliesMock, threadMock, sendOpMock, noticeMock, graphqlMock } =
  vi.hoisted(() => ({
    adminAuthMock: vi.fn(),
    listRepliesMock: vi.fn(),
    threadMock: vi.fn(),
    sendOpMock: vi.fn(),
    noticeMock: vi.fn(),
    graphqlMock: vi.fn(),
  }));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: adminAuthMock },
}));
vi.mock("../app/services/customer-inbox.server", () => ({
  listUnseenReplies: listRepliesMock,
  getOrderThread: threadMock,
}));
vi.mock("../app/services/send-customer-email.server", () => ({
  handleSendEmailOp: sendOpMock,
}));
vi.mock("../app/services/reschedule-notice.server", () => ({
  sendRescheduleNotice: noticeMock,
}));

import * as replies from "../app/routes/api.email.replies";
import * as thread from "../app/routes/api.email.thread";
import * as send from "../app/routes/api.email.send";
import * as notice from "../app/routes/api.email.reschedule-notice";

const SHOP = "flowercart-dev.myshopify.com";
const ORDER_GID = "gid://shopify/Order/111";
const admin = { graphql: graphqlMock };
const cors = vi.fn((r: Response) => {
  r.headers.set("Access-Control-Allow-Origin", "*");
  return r;
});

function orderResponse(order: unknown) {
  return { json: async () => ({ data: { order } }) };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adminAuthMock.mockResolvedValue({ admin, session: { shop: SHOP }, cors });
});

describe("GET /api/email/replies", () => {
  it("returns the inbox result with CORS headers", async () => {
    listRepliesMock.mockResolvedValue({ ok: true, data: [{ orderId: ORDER_GID }] });
    const res = await replies.loader({ request: new Request("https://app.example.com/api/email/replies") } as never);
    expect(await res.json()).toEqual({ ok: true, data: [{ orderId: ORDER_GID }] });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(listRepliesMock).toHaveBeenCalledWith(admin);
  });

  it("rejects a request without a valid ID token", async () => {
    adminAuthMock.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(
      replies.loader({ request: new Request("https://app.example.com/api/email/replies") } as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(listRepliesMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/email/thread", () => {
  it("rejects an invalid order id before reading Shopify", async () => {
    const res = await thread.loader({
      request: new Request("https://app.example.com/api/email/thread?orderId=abc"),
    } as never);
    expect(res.status).toBe(400);
    expect(graphqlMock).not.toHaveBeenCalled();
  });

  it("reads the order name and customer email from Shopify", async () => {
    graphqlMock.mockResolvedValue(
      orderResponse({
        id: ORDER_GID,
        name: "#1046",
        email: "order@example.com",
        customer: { defaultEmailAddress: { emailAddress: "customer@example.com" } },
      }),
    );
    threadMock.mockResolvedValue({ ok: true, data: [] });
    const res = await thread.loader({
      request: new Request(`https://app.example.com/api/email/thread?orderId=${encodeURIComponent(ORDER_GID)}`),
    } as never);
    expect(await res.json()).toEqual({ ok: true, data: [] });
    expect(threadMock).toHaveBeenCalledWith({ orderName: "#1046", customerEmail: "customer@example.com" });
  });
});

describe("POST /api/email/send", () => {
  it("passes only the allowed fields to the send op", async () => {
    sendOpMock.mockResolvedValue(Response.json({ ok: true, message: "Email sent to c@example.com." }));
    const res = await send.action({
      request: post("/api/email/send", {
        orderId: ORDER_GID,
        subject: " Hello ",
        body: "Hi",
        to: "attacker@example.com",
      }),
    } as never);
    expect(await res.json()).toEqual({ ok: true, message: "Email sent to c@example.com." });
    const fd = sendOpMock.mock.calls[0][1] as FormData;
    expect(fd.get("orderId")).toBe(ORDER_GID);
    expect(fd.get("subject")).toBe("Hello");
    expect(fd.has("to")).toBe(false);
  });

  it("rejects a body that is not a JSON object", async () => {
    const res = await send.action({ request: post("/api/email/send", ["x"]) } as never);
    expect(res.status).toBe(400);
    expect(sendOpMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/email/reschedule-notice", () => {
  const input = {
    orderId: ORDER_GID,
    fromDate: "2026-10-10",
    fromTimeSlot: "9AM-12PM",
    toDate: "2026-10-11",
    toTimeSlot: "1PM-5PM",
    to: "attacker@example.com",
  };

  it("sends to the customer email on the order, not the one in the request", async () => {
    graphqlMock.mockResolvedValue(
      orderResponse({
        id: ORDER_GID,
        name: "#1046",
        email: null,
        customer: { firstName: "Ana", defaultEmailAddress: { emailAddress: "ana@example.com" } },
      }),
    );
    noticeMock.mockResolvedValue({ status: "sent", to: "ana@example.com" });
    const res = await notice.action({ request: post("/api/email/reschedule-notice", input) } as never);
    expect(await res.json()).toEqual({ status: "sent", to: "ana@example.com" });
    expect(noticeMock).toHaveBeenCalledWith(SHOP, {
      orderId: ORDER_GID,
      orderName: "#1046",
      to: "ana@example.com",
      firstName: "Ana",
      fromDate: "2026-10-10",
      fromTimeSlot: "9AM-12PM",
      toDate: "2026-10-11",
      toTimeSlot: "1PM-5PM",
    });
  });

  it("rejects an invalid date before reading Shopify", async () => {
    const res = await notice.action({
      request: post("/api/email/reschedule-notice", { ...input, toDate: "tomorrow" }),
    } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "failed", error: "Invalid date." });
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
