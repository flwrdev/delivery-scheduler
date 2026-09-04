import { describe, expect, it } from "vitest";

import {
  RESCHEDULE_SEEN_METAFIELD,
  handleMarkRescheduleSeenOp,
  parseMarkRescheduleSeenInput,
} from "../app/services/reschedule-seen.server";

type Call = { query: string; variables?: Record<string, unknown> };

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(respond: () => unknown) {
  const calls: Call[] = [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ query, variables: options?.variables });
      const body = respond();
      if (body instanceof Error) throw body;
      return jsonResponse(body);
    },
  };
  return { admin, calls };
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

describe("parseMarkRescheduleSeenInput", () => {
  it("accepts an Order GID + parseable timestamp and normalises to ISO", () => {
    const parsed = parseMarkRescheduleSeenInput(
      form({
        orderId: "gid://shopify/Order/7201903673531",
        requestedAt: "2026-09-04T00:47:01.792Z",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      orderId: "gid://shopify/Order/7201903673531",
      seenAt: "2026-09-04T00:47:01.792Z",
    });
  });

  it("rejects a numeric id and a bad timestamp", () => {
    expect(
      parseMarkRescheduleSeenInput(form({ orderId: "7201903673531", requestedAt: "2026-09-04T00:47:01Z" })).ok,
    ).toBe(false);
    expect(
      parseMarkRescheduleSeenInput(form({ orderId: "gid://shopify/Order/1", requestedAt: "yesterday" })).ok,
    ).toBe(false);
  });
});

describe("handleMarkRescheduleSeenOp", () => {
  it("writes $app.reschedule_seen_at with the acknowledged event's timestamp", async () => {
    const { admin, calls } = makeAdmin(() => ({
      data: { metafieldsSet: { metafields: [{ id: "m1" }], userErrors: [] } },
    }));
    const response = await handleMarkRescheduleSeenOp(
      admin,
      form({
        orderId: "gid://shopify/Order/7201903673531",
        requestedAt: "2026-09-04T00:47:01.792Z",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, action: "markRescheduleSeen" });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({
      metafields: [
        {
          ownerId: "gid://shopify/Order/7201903673531",
          namespace: RESCHEDULE_SEEN_METAFIELD.namespace,
          key: RESCHEDULE_SEEN_METAFIELD.key,
          type: "date_time",
          value: "2026-09-04T00:47:01.792Z",
        },
      ],
    });
  });

  it("answers 400 for invalid input without calling Shopify", async () => {
    const { admin, calls } = makeAdmin(() => ({}));
    const response = await handleMarkRescheduleSeenOp(admin, form({ orderId: "nope" }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("turns userErrors and thrown upstream failures into 200 + ok:false (ADR-11)", async () => {
    const userError = makeAdmin(() => ({
      data: { metafieldsSet: { metafields: [], userErrors: [{ message: "nope" }] } },
    }));
    const r1 = await handleMarkRescheduleSeenOp(
      userError.admin,
      form({ orderId: "gid://shopify/Order/1", requestedAt: "2026-09-04T00:47:01Z" }),
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).ok).toBe(false);

    const thrown = makeAdmin(() => new Error("socket hang up"));
    const r2 = await handleMarkRescheduleSeenOp(
      thrown.admin,
      form({ orderId: "gid://shopify/Order/1", requestedAt: "2026-09-04T00:47:01Z" }),
    );
    expect(r2.status).toBe(200);
    expect((await r2.json()).ok).toBe(false);
  });
});
