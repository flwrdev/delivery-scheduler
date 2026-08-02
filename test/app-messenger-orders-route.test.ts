import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loader/action tests only — the Polaris/App Bridge UI is stubbed out (this
// suite runs in plain node, no jsdom) and shopify.server is fully mocked (its
// Prisma session storage cannot initialize inside vitest).

const { prismaMock, adminMock, componentStub } = vi.hoisted(() => ({
  prismaMock: {
    messengerThread: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  adminMock: vi.fn(),
  componentStub: () => null,
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: adminMock },
}));

vi.mock("@shopify/polaris", () => ({
  Badge: componentStub,
  Banner: componentStub,
  BlockStack: componentStub,
  Button: componentStub,
  Card: componentStub,
  EmptyState: componentStub,
  IndexTable: Object.assign(componentStub, { Row: componentStub, Cell: componentStub }),
  Layout: Object.assign(componentStub, { Section: componentStub }),
  Page: componentStub,
  Text: componentStub,
}));
vi.mock("@shopify/app-bridge-react", () => ({ TitleBar: componentStub }));

import { action, loader } from "../app/routes/app.messenger-orders";

const ROUTE_URL = "https://app.example.com/app/messenger-orders";

function makeActionRequest(fields: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

beforeEach(() => {
  adminMock.mockResolvedValue({ session: { shop: "flowercart.myshopify.com" } });
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
