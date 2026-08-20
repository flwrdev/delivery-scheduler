import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Occasion reminders — pins the nightly scan+send behavior: idempotent row
// creation, the two candidate sources (last-year orders + roll-forward),
// cross-source dedupe, consent/suppression skips (scan AND send time), the
// merchant's 2nd-email re-order check, the merchant's verbatim email
// template, retry/FAILED accounting, unsubscribe token integrity, and the
// zero-order-writes source guard.

const sendCustomerEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../app/services/send-customer-email.server", () => ({
  sendCustomerEmail: sendCustomerEmailMock,
}));

interface Row {
  id: string;
  shop: string;
  shopifyOrderId: string;
  occasionDate: Date;
  occasionYear: number;
  occasionType: string;
  touch: string;
  detectSource: string;
  customerEmail: string | null;
  customerFirstName: string | null;
  recipientHint: string | null;
  cardMessageExcerpt: string | null;
  productTitles: string | null;
  status: string;
  attemptCount: number;
  priorYearsSent: number;
  suggestedAt: Date;
  sentAt: Date | null;
  updatedAt: Date;
}

interface SuppressionRow {
  id: string;
  shop: string;
  email: string;
  scope: string;
  source: string;
}

type DateCond = Date | { gte?: Date; lte?: Date };

interface ReminderWhere {
  shop?: string;
  touch?: string;
  status?: string;
  shopifyOrderId?: string;
  id?: string;
  attemptCount?: { lt: number };
  occasionDate?: DateCond;
  customerEmail?: { equals: string; mode?: string };
  shop_shopifyOrderId_occasionYear_touch?: {
    shop: string;
    shopifyOrderId: string;
    occasionYear: number;
    touch: string;
  };
}

interface SuppressionWhere {
  shop?: string;
  email?: string;
  scope?: { in?: string[] };
  shop_email_scope?: { shop: string; email: string; scope: string };
}

const fake = vi.hoisted(() => {
  interface State {
    reminders: Row[];
    suppressions: SuppressionRow[];
    emailLogs: Array<Record<string, string>>;
    config: { shop: string; enabled: boolean };
    idSeq: number;
  }
  const state: State = {
    reminders: [],
    suppressions: [],
    emailLogs: [],
    config: { shop: "", enabled: true },
    idSeq: 1,
  };

  const matchesDate = (value: Date, cond: DateCond): boolean => {
    if (cond instanceof Date) return value.getTime() === cond.getTime();
    if (cond.gte && value.getTime() < cond.gte.getTime()) return false;
    if (cond.lte && value.getTime() > cond.lte.getTime()) return false;
    return true;
  };

  const prisma = {
    reminderConfig: {
      findUnique: async ({ where }: { where: { shop: string } }) =>
        state.config.shop === where.shop ? { ...state.config } : null,
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { shop: string };
        update: Partial<{ enabled: boolean }>;
        create: { shop: string; enabled: boolean };
      }) => {
        if (state.config.shop === where.shop) Object.assign(state.config, update);
        else state.config = { ...create };
        return { ...state.config };
      },
    },
    deliveryScheduleConfig: {
      findUnique: async () => ({ timezone: "Asia/Manila", cutoffHour: 14 }),
    },
    occasionReminder: {
      create: async ({ data }: { data: Partial<Row> }) => {
        const dup = state.reminders.find(
          (r) =>
            r.shop === data.shop &&
            r.shopifyOrderId === data.shopifyOrderId &&
            r.occasionYear === data.occasionYear &&
            r.touch === data.touch,
        );
        if (dup) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        const row: Row = {
          id: `r${state.idSeq++}`,
          shop: "",
          shopifyOrderId: "",
          occasionDate: new Date(0),
          occasionYear: 0,
          occasionType: "generic",
          touch: "7d",
          detectSource: "none",
          status: "PENDING",
          attemptCount: 0,
          priorYearsSent: 0,
          suggestedAt: new Date("2026-08-21T00:00:00Z"),
          sentAt: null,
          customerEmail: null,
          customerFirstName: null,
          recipientHint: null,
          cardMessageExcerpt: null,
          productTitles: null,
          ...data,
          updatedAt: new Date(),
        };
        state.reminders.push(row);
        return { ...row };
      },
      findMany: async ({ where, take }: { where: ReminderWhere; take?: number }) => {
        let rows = state.reminders.filter((r) => {
          if (where.shop && r.shop !== where.shop) return false;
          if (where.touch && r.touch !== where.touch) return false;
          if (typeof where.status === "string" && r.status !== where.status) return false;
          if (where.attemptCount?.lt !== undefined && !(r.attemptCount < where.attemptCount.lt))
            return false;
          if (where.occasionDate && !matchesDate(r.occasionDate, where.occasionDate)) return false;
          return true;
        });
        rows = rows.sort((a, b) => a.occasionDate.getTime() - b.occasionDate.getTime());
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: { where: ReminderWhere }) => {
        if (where.id) {
          const row = state.reminders.find((r) => r.id === where.id);
          return row ? { ...row } : null;
        }
        const key = where.shop_shopifyOrderId_occasionYear_touch;
        if (key) {
          const row = state.reminders.find(
            (r) =>
              r.shop === key.shop &&
              r.shopifyOrderId === key.shopifyOrderId &&
              r.occasionYear === key.occasionYear &&
              r.touch === key.touch,
          );
          return row ? { ...row } : null;
        }
        return null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = state.reminders.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: ReminderWhere; data: Partial<Row> }) => {
        let count = 0;
        for (const row of state.reminders) {
          if (where.shop && row.shop !== where.shop) continue;
          if (where.status && row.status !== where.status) continue;
          if (where.shopifyOrderId && row.shopifyOrderId !== where.shopifyOrderId) continue;
          if (
            where.customerEmail?.equals &&
            (row.customerEmail ?? "").toLowerCase() !== where.customerEmail.equals.toLowerCase()
          )
            continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
    },
    reminderSuppression: {
      findFirst: async ({ where }: { where: SuppressionWhere }) => {
        const row = state.suppressions.find(
          (s) =>
            s.shop === where.shop &&
            s.email === where.email &&
            (where.scope?.in ? where.scope.in.includes(s.scope) : true),
        );
        return row ? { ...row } : null;
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { shop_email_scope: { shop: string; email: string; scope: string } };
        update: Record<string, never>;
        create: Omit<SuppressionRow, "id">;
      }) => {
        const key = where.shop_email_scope;
        const existing = state.suppressions.find(
          (s) => s.shop === key.shop && s.email === key.email && s.scope === key.scope,
        );
        if (existing) return { ...existing };
        const row: SuppressionRow = { id: `s${state.idSeq++}`, ...create };
        state.suppressions.push(row);
        return { ...row };
      },
      count: async () => state.suppressions.length,
    },
    emailSendLog: {
      create: async ({ data }: { data: Record<string, string> }) => {
        state.emailLogs.push({ ...data });
        return { ...data };
      },
    },
  };

  return { state, prisma };
});

vi.mock("../app/db.server", () => ({ default: fake.prisma }));

import {
  makeUnsubscribeToken,
  runReminderScan,
  verifyUnsubscribeToken,
} from "../app/services/occasion-reminders.server";

const SHOP = "flowercart-dev.myshopify.com";
// 2026-08-21 10:00 Manila. today = 2026-08-21; 7d window = Aug 28–30;
// 3d window = Aug 24–26.
const NOW = new Date("2026-08-21T02:00:00Z");

interface OrderNodeOverrides {
  id?: string;
  cardMessage?: string | null;
  note?: string | null;
  email?: string | null;
  marketingState?: string | null;
  deliveryDate?: string | null;
  billingFirstName?: string | null;
  shippingFirstName?: string | null;
  cancelledAt?: string | null;
}

function orderNode(overrides: OrderNodeOverrides = {}) {
  const {
    id = "gid://shopify/Order/1001",
    cardMessage = "Happy Birthday!",
    note = null,
    email = "juan@example.com",
    marketingState = "SUBSCRIBED",
    deliveryDate = "2025-08-28",
    billingFirstName = "Juan",
    shippingFirstName = "Maria",
    cancelledAt = null,
  } = overrides;
  return {
    id,
    name: "#4001",
    note,
    cancelledAt,
    customAttributes: cardMessage ? [{ key: "Card Message", value: cardMessage }] : [],
    customer: {
      firstName: billingFirstName,
      defaultEmailAddress: email ? { emailAddress: email, marketingState } : null,
    },
    billingAddress: { firstName: billingFirstName, name: `${billingFirstName} Dela Cruz` },
    shippingAddress: shippingFirstName
      ? { firstName: shippingFirstName, name: `${shippingFirstName} Santos` }
      : null,
    deliveryDateMetafield: deliveryDate ? { value: deliveryDate } : null,
    fulfillments: [],
    lineItems: { edges: [{ node: { title: "Classic Red Roses" } }] },
  };
}

function makeAdmin(options: { orders?: unknown[]; reorderHit?: boolean } = {}) {
  const { orders = [], reorderHit = false } = options;
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const admin = {
    graphql: async (
      query: string,
      opts?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ query, variables: opts?.variables });
      let payload: unknown;
      if (query.includes("OccasionReminderScan")) {
        payload = {
          data: {
            orders: {
              edges: orders.map((node) => ({ node })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      } else if (query.includes("OccasionReminderReorderCheck")) {
        payload = {
          data: {
            orders: { edges: reorderHit ? [{ node: { id: "gid://shopify/Order/9" } }] : [] },
          },
        };
      } else {
        payload = { data: {} };
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  return { admin, calls };
}

function seedReminder(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: `seed${fake.state.idSeq++}`,
    shop: SHOP,
    shopifyOrderId: "gid://shopify/Order/900",
    occasionDate: new Date("2026-08-24T00:00:00.000Z"),
    occasionYear: 2026,
    occasionType: "birthday",
    touch: "3d",
    detectSource: "card_message",
    customerEmail: "juan@example.com",
    customerFirstName: "Juan",
    recipientHint: "Maria",
    cardMessageExcerpt: "Happy Birthday!",
    productTitles: "Classic Red Roses",
    status: "PENDING",
    attemptCount: 0,
    priorYearsSent: 0,
    suggestedAt: new Date("2026-08-17T00:00:00Z"),
    sentAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
  fake.state.reminders.push(row);
  return row;
}

beforeEach(() => {
  fake.state.reminders.length = 0;
  fake.state.suppressions.length = 0;
  fake.state.emailLogs.length = 0;
  fake.state.config = { shop: SHOP, enabled: true };
  sendCustomerEmailMock.mockReset();
  sendCustomerEmailMock.mockResolvedValue({ ok: true });
  vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "test-unsub-secret");
  vi.stubEnv("SHOPIFY_APP_URL", "https://app.flowercart.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runReminderScan", () => {
  it("short-circuits when the kill switch is off — no Shopify calls, no sends", async () => {
    fake.state.config.enabled = false;
    const { admin, calls } = makeAdmin();
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.disabled).toBe(true);
    expect(calls.length).toBe(0);
    expect(sendCustomerEmailMock).not.toHaveBeenCalled();
  });

  it("creates a 7d row from a last-year order and sends the merchant's template", async () => {
    const { admin } = makeAdmin({ orders: [orderNode()] });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.created).toBe(1);
    expect(summary.sent).toBe(1);
    const row = fake.state.reminders[0];
    expect(row.touch).toBe("7d");
    expect(row.status).toBe("SENT");
    expect(row.occasionYear).toBe(2026);
    expect(row.recipientHint).toBe("Maria"); // shipping name, never card parsing

    const [{ to, subject, textBody }] = sendCustomerEmailMock.mock.calls[0];
    expect(to).toBe("juan@example.com");
    // Subject option 2 — recipient + detected occasion.
    expect(subject).toBe("Maria's birthday is coming up");
    expect(textBody).toContain("Hi Juan,");
    expect(textBody).toContain("A little reminder, a little time to prepare.");
    expect(textBody).toContain("you sent Classic Red Roses to Maria for birthday");
    expect(textBody).toContain("August 28 is just a week away");
    expect(textBody).toContain("Order before 2 PM for same-day delivery");
    // No discount in the 7d email; unsubscribe footer always present.
    expect(textBody).not.toContain("ANNIV200");
    expect(textBody).toContain("Unsubscribe: https://app.flowercart.test/public/reminder-unsubscribe?token=");
    expect(textBody).toContain("The Flowercart · 255 Kawit St, Manila");

    // The audit row surfaces in the order panel's timeline.
    expect(fake.state.emailLogs).toHaveLength(1);
    expect(fake.state.emailLogs[0].shopifyOrderId).toBe("gid://shopify/Order/1001");
  });

  it("is idempotent — a second run creates and sends nothing new", async () => {
    const { admin } = makeAdmin({ orders: [orderNode()] });
    await runReminderScan({ admin, shop: SHOP, now: NOW });
    const second = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(fake.state.reminders).toHaveLength(1);
    expect(sendCustomerEmailMock).toHaveBeenCalledTimes(1);
  });

  it("uses fallback words when occasion and recipient are unknown", async () => {
    const { admin } = makeAdmin({
      orders: [orderNode({ cardMessage: "Love you!", shippingFirstName: null })],
    });
    await runReminderScan({ admin, shop: SHOP, now: NOW });

    const [{ subject, textBody }] = sendCustomerEmailMock.mock.calls[0];
    expect(subject).toBe("A little reminder about your special day 🌸");
    expect(textBody).toContain("to someone special for your special day");
  });

  it("treats a recipient identical to the buyer as unknown (self-order)", async () => {
    const { admin } = makeAdmin({
      orders: [orderNode({ billingFirstName: "Juan", shippingFirstName: "Juan" })],
    });
    await runReminderScan({ admin, shop: SHOP, now: NOW });
    const [{ textBody }] = sendCustomerEmailMock.mock.calls[0];
    expect(textBody).toContain("to someone special");
  });

  it("hard-skips customers whose Shopify marketing state is UNSUBSCRIBED", async () => {
    const { admin } = makeAdmin({ orders: [orderNode({ marketingState: "UNSUBSCRIBED" })] });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.skippedConsent).toBe(1);
    expect(summary.created).toBe(0);
    expect(sendCustomerEmailMock).not.toHaveBeenCalled();
  });

  it("skips suppressed emails at scan time", async () => {
    fake.state.suppressions.push({
      id: "s1",
      shop: SHOP,
      email: "juan@example.com",
      scope: "all",
      source: "unsubscribe_link",
    });
    const { admin } = makeAdmin({ orders: [orderNode()] });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.skippedSuppressed).toBe(1);
    expect(summary.created).toBe(0);
  });

  it("suppresses a PENDING 3d row at send time — an unsubscribe after the 7d email stops the 2nd", async () => {
    seedReminder(); // PENDING 3d row inside the send-due range
    fake.state.suppressions.push({
      id: "s1",
      shop: SHOP,
      email: "juan@example.com",
      scope: "all",
      source: "unsubscribe_link",
    });
    const { admin } = makeAdmin();
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.skippedSuppressed).toBe(1);
    expect(fake.state.reminders[0].status).toBe("SUPPRESSED");
    expect(sendCustomerEmailMock).not.toHaveBeenCalled();
  });

  it("skips the 3d email when the customer ordered since the 7d send (merchant's 2nd-email rule)", async () => {
    seedReminder({
      shopifyOrderId: "gid://shopify/Order/900",
      touch: "7d",
      status: "SENT",
      sentAt: new Date("2026-08-17T21:00:00Z"),
      occasionDate: new Date("2026-08-24T00:00:00.000Z"),
    });
    seedReminder({ shopifyOrderId: "gid://shopify/Order/900", touch: "3d" });
    const { admin, calls } = makeAdmin({ reorderHit: true });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.skippedReordered).toBe(1);
    const row = fake.state.reminders.find((r) => r.touch === "3d")!;
    expect(row.status).toBe("SKIPPED_REORDERED");
    expect(sendCustomerEmailMock).not.toHaveBeenCalled();
    const reorderCall = calls.find((c) => c.query.includes("OccasionReminderReorderCheck"))!;
    expect(String(reorderCall.variables?.query)).toContain('email:"juan@example.com"');
    expect(String(reorderCall.variables?.query)).toContain("created_at:>=2026-08-17T21:00:00");
  });

  it("sends the 3d email with the ANNIV200 code when no re-order is found", async () => {
    seedReminder({
      shopifyOrderId: "gid://shopify/Order/900",
      touch: "7d",
      status: "SENT",
      sentAt: new Date("2026-08-17T21:00:00Z"),
    });
    seedReminder({ shopifyOrderId: "gid://shopify/Order/900", touch: "3d" });
    const { admin } = makeAdmin({ reorderHit: false });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.sent).toBe(1);
    const [{ subject, textBody }] = sendCustomerEmailMock.mock.calls[0];
    expect(subject).toBe("Still time for birthday, plus ₱200 off");
    expect(textBody).toContain("A little more time, a little more to celebrate.");
    expect(textBody).toContain("we remember Maria was on your mind this time last year");
    expect(textBody).toContain("use ANNIV200 at checkout for ₱200 off");
    expect(textBody).toContain("Already placed your order? You're all set, no action needed.");
    expect(textBody).toContain("Cutoff for same-day delivery is 2 PM.");
  });

  it("rolls a SENT chain forward a year with priorYearsSent+1", async () => {
    seedReminder({
      shopifyOrderId: "gid://shopify/Order/800",
      touch: "7d",
      status: "SENT",
      sentAt: new Date("2025-08-21T21:00:00Z"),
      occasionDate: new Date("2025-08-28T00:00:00.000Z"),
      occasionYear: 2025,
      priorYearsSent: 0,
    });
    const { admin } = makeAdmin({ orders: [] });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.created).toBe(1);
    const rolled = fake.state.reminders.find((r) => r.occasionYear === 2026)!;
    expect(rolled.touch).toBe("7d");
    expect(rolled.priorYearsSent).toBe(1);
    expect(rolled.occasionDate.toISOString().slice(0, 10)).toBe("2026-08-28");
    expect(summary.sent).toBe(1);
  });

  it("suppression cuts the yearly roll-forward chain", async () => {
    seedReminder({
      shopifyOrderId: "gid://shopify/Order/800",
      touch: "7d",
      status: "SENT",
      occasionDate: new Date("2025-08-28T00:00:00.000Z"),
      occasionYear: 2025,
    });
    fake.state.suppressions.push({
      id: "s1",
      shop: SHOP,
      email: "juan@example.com",
      scope: "all",
      source: "unsubscribe_link",
    });
    const { admin } = makeAdmin();
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.created).toBe(0);
    expect(summary.skippedSuppressed).toBe(1);
  });

  it("dedupes a fresh re-order against the old chain — Source A wins", async () => {
    // Old chain from 2025 rolls to Aug 28, 2026...
    seedReminder({
      shopifyOrderId: "gid://shopify/Order/800",
      touch: "7d",
      status: "SENT",
      occasionDate: new Date("2025-08-28T00:00:00.000Z"),
      occasionYear: 2025,
    });
    // ...while the customer also re-ordered last year for the same date.
    const { admin } = makeAdmin({
      orders: [orderNode({ id: "gid://shopify/Order/1002", deliveryDate: "2025-08-28" })],
    });
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.skippedDuplicateOccasion).toBe(1);
    expect(summary.created).toBe(1);
    const created = fake.state.reminders.find((r) => r.occasionYear === 2026)!;
    expect(created.shopifyOrderId).toBe("gid://shopify/Order/1002"); // the fresh order
  });

  it("counts a failed send, keeps PENDING, and FAILs after 3 attempts", async () => {
    seedReminder({ attemptCount: 2 });
    sendCustomerEmailMock.mockResolvedValue({ ok: false, error: "smtp down" });
    const { admin } = makeAdmin();
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });

    expect(summary.failed).toBe(1);
    expect(fake.state.reminders[0].status).toBe("FAILED");
    expect(fake.state.reminders[0].attemptCount).toBe(3);
  });

  it("holds all sends when the unsubscribe secret is missing", async () => {
    vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "");
    seedReminder();
    const { admin } = makeAdmin();
    const summary = await runReminderScan({ admin, shop: SHOP, now: NOW });
    expect(summary.sent).toBe(0);
    expect(sendCustomerEmailMock).not.toHaveBeenCalled();
    expect(fake.state.reminders[0].status).toBe("PENDING");
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips and lowercases the email", () => {
    const token = makeUnsubscribeToken({ email: "Juan@Example.com", scope: "all" })!;
    expect(verifyUnsubscribeToken(token)).toEqual({ email: "juan@example.com", scope: "all" });
  });

  it("rejects tampered tokens", () => {
    const token = makeUnsubscribeToken({ email: "juan@example.com", scope: "all" })!;
    const [body] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ email: "other@example.com", scope: "all" }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${token.split(".")[1]}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${body}.AAAA`)).toBeNull();
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
  });

  it("returns null without the secret", () => {
    vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "");
    expect(makeUnsubscribeToken({ email: "a@b.c", scope: "all" })).toBeNull();
  });
});

describe("read-only guard", () => {
  it("keeps every mutation string out of the reminder route + service sources", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "app/services/occasion-reminders.server.ts",
      "app/services/occasion-detection.server.ts",
      "app/services/reminder-copy.server.ts",
      "app/routes/internal.reminder-scan.ts",
      "app/routes/public.reminder-unsubscribe.ts",
      "app/routes/app.reminders.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // Catches `mutation Foo(`, `mutation Foo {` and anonymous `mutation {`.
      expect(source, file).not.toMatch(/\bmutation\s*(?:\w+\s*)?[({]/);
      expect(source, file).not.toMatch(/metafieldsSet|orderUpdate|tagsAdd|tagsRemove/);
      expect(source, file).not.toMatch(
        /upsertScheduleRules|rescheduleOrderDelivery|syncOrderDeliveryMetafields|syncOrderDeliveryScheduleTag/,
      );
    }
  });
});
