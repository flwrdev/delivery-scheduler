import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

import prisma from "../db.server";
import { getOrderStatus } from "../lib/lalamove-client.server";
import { markLalamoveOrderDelivered, mirrorLalamoveOrderStatus } from "../services/lalamove-tracking.server";
import { unauthenticated } from "../shopify.server";

// THE PRIMARY mechanism for ADR-16 (revised same-day, 2026-08-16 — the
// webhook path is confirmed non-functional for this merchant's orders, see
// the ADR-16 addendum in decisions.md). Triggered by the Google Cloud
// Scheduler job `delivery-scheduler-lalamove-poll` every 10 minutes (cut
// down from 30 the same day after a live gap — see the ADR-16 addendum in
// decisions.md; Cloud Run has no native cron), auth'd with a shared secret header rather than
// Lalamove's HMAC scheme (this endpoint is our own, not Lalamove's).
//
// Polls getOrderStatus for every LalamoveTracking row that isn't delivered
// yet — no staleness gate. This originally waited 2 hours before polling a
// row (reasonable for a fallback behind a working webhook), but that design
// assumed the webhook would catch fast deliveries; since it never fires at
// all, gating on staleness meant a delivery completed within 2 hours of
// being recorded was invisible to this route for the whole window. There is
// no Lalamove "list orders" endpoint (confirmed against the live API
// reference), so this can only ever poll ids it already knows about via
// `recordLalamoveOrderId` (the merchant pasting the id into the "Mark as
// fulfilled" modal) — it cannot discover orders on its own.

const MAX_ROWS_PER_RUN = 50;

// Statuses Lalamove will never move on from — a row stuck at one of these
// would otherwise be polled forever (only markLalamoveOrderDelivered sets
// deliveredAt; mirrorLalamoveOrderStatus, the only thing that touches a
// terminal-but-not-COMPLETE row, never does), eventually crowding out
// genuinely in-flight deliveries from a capped MAX_ROWS_PER_RUN run.
const TERMINAL_NON_DELIVERED_STATUSES = ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"];

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const pollSecret = process.env.LALAMOVE_POLL_SECRET?.trim();
  const provided = request.headers.get("x-lalamove-poll-secret")?.trim();
  if (!pollSecret || !provided || !timingSafeEqualStrings(provided, pollSecret)) {
    return new Response(null, { status: 401 });
  }

  const shop = process.env.LALAMOVE_SHOP?.trim();
  if (!shop) {
    console.error("[lalamove-poll] LALAMOVE_SHOP not configured");
    return Response.json({ ok: false, error: "not configured" }, { status: 200 });
  }

  const pending = await prisma.lalamoveTracking.findMany({
    where: {
      deliveredAt: null,
      status: { notIn: TERMINAL_NON_DELIVERED_STATUSES },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ROWS_PER_RUN,
  });

  if (pending.length === 0) {
    return Response.json({ ok: true, checked: 0, delivered: 0 });
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.warn(
      `[lalamove-poll] no offline session for ${shop} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return Response.json({ ok: false, error: "no offline session" }, { status: 200 });
  }

  let delivered = 0;
  let errored = 0;
  for (const row of pending) {
    // One row's failure (e.g. a transient Shopify Admin API network error
    // inside markLalamoveOrderDelivered) must never abort the rest of the
    // batch — every other pending row still deserves its check this cycle.
    try {
      const statusResult = await getOrderStatus(row.lalamoveOrderId);
      await prisma.lalamoveTracking.update({
        where: { lalamoveOrderId: row.lalamoveOrderId },
        data: { lastPolledAt: new Date() },
      });

      if (!statusResult.ok) {
        console.warn(
          `[lalamove-poll] getOrderStatus failed for ${row.lalamoveOrderId}: ${
            statusResult.notFound ? "not found" : statusResult.error
          }`,
        );
        continue;
      }

      if (statusResult.order.status === "COMPLETED" || statusResult.order.status === "COMPLETE") {
        const result = await markLalamoveOrderDelivered(admin, shop, row.lalamoveOrderId, statusResult.order);
        if (result.status === "delivered") delivered++;
        console.log(`[lalamove-poll] ${row.lalamoveOrderId}: ${result.status}`);
      } else {
        await mirrorLalamoveOrderStatus(row.lalamoveOrderId, statusResult.order.status);
      }
    } catch (error) {
      errored++;
      console.warn(
        `[lalamove-poll] row ${row.lalamoveOrderId} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return Response.json({ ok: true, checked: pending.length, delivered, errored });
};
