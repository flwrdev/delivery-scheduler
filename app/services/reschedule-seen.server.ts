import type { AdminGraphQLClient } from "./order-delivery-metafields.server";

// The `markRescheduleSeen` op behind the Orders Ops "Rescheduled today"
// banner's Seen button (2026-09-04). It records the requestedAt of the
// reschedule the merchant acknowledged on an app-reserved order metafield.
//
// Why a `$app` metafield and not Postgres or a tag: no migration, shared across
// every device/staff member (unlike localStorage), invisible to other apps, and
// keyed by the event's own timestamp — so a later reschedule of the same order
// (a newer requestedAt) resurfaces on its own. It is an ORDER write but NOT a
// delivery write: it touches none of the fields in api.md §2.

export const RESCHEDULE_SEEN_METAFIELD = {
  namespace: "$app",
  key: "reschedule_seen_at",
  type: "date_time",
} as const;

const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

const MARK_RESCHEDULE_SEEN_MUTATION = `#graphql
  mutation MarkRescheduleSeen($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

export interface MarkRescheduleSeenResponse {
  ok: boolean;
  action: "markRescheduleSeen";
  message: string;
  orderId: string | null;
}

export type MarkRescheduleSeenInput =
  | { ok: true; orderId: string; seenAt: string }
  | { ok: false; message: string };

export function parseMarkRescheduleSeenInput(fd: FormData): MarkRescheduleSeenInput {
  const orderId = String(fd.get("orderId") ?? "").trim();
  const requestedAt = String(fd.get("requestedAt") ?? "").trim();
  if (!ORDER_GID_RE.test(orderId)) {
    return { ok: false, message: "orderId must be an Order GID." };
  }
  const ts = Date.parse(requestedAt);
  if (Number.isNaN(ts)) {
    return { ok: false, message: "requestedAt must be a valid timestamp." };
  }
  return { ok: true, orderId, seenAt: new Date(ts).toISOString() };
}

interface MetafieldsSetBody {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{ field?: string[] | null; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export async function handleMarkRescheduleSeenOp(
  admin: AdminGraphQLClient,
  fd: FormData,
): Promise<Response> {
  const input = parseMarkRescheduleSeenInput(fd);
  if (!input.ok) {
    // Validation stays 4xx; only upstream trouble is 200 + ok:false (ADR-11).
    return Response.json(
      {
        ok: false,
        action: "markRescheduleSeen",
        message: input.message,
        orderId: null,
      } satisfies MarkRescheduleSeenResponse,
      { status: 400 },
    );
  }

  try {
    const response = await admin.graphql(MARK_RESCHEDULE_SEEN_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId: input.orderId,
            namespace: RESCHEDULE_SEEN_METAFIELD.namespace,
            key: RESCHEDULE_SEEN_METAFIELD.key,
            type: RESCHEDULE_SEEN_METAFIELD.type,
            value: input.seenAt,
          },
        ],
      },
    });
    const body = (await response.json()) as MetafieldsSetBody;
    const errors = [
      ...(body.errors?.map((e) => e.message) ?? []),
      ...(body.data?.metafieldsSet?.userErrors?.map((e) => e.message) ?? []),
    ];
    if (errors.length > 0) {
      console.warn(
        `[orders action] markRescheduleSeen ${input.orderId}: ${errors.join("; ")}`,
      );
      return Response.json({
        ok: false,
        action: "markRescheduleSeen",
        message: "Could not mark this reschedule as seen. Try again in a moment.",
        orderId: input.orderId,
      } satisfies MarkRescheduleSeenResponse);
    }
    return Response.json({
      ok: true,
      action: "markRescheduleSeen",
      message: "Marked as seen.",
      orderId: input.orderId,
    } satisfies MarkRescheduleSeenResponse);
  } catch (error) {
    console.warn(
      `[orders action] markRescheduleSeen threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return Response.json({
      ok: false,
      action: "markRescheduleSeen",
      message: "Could not mark this reschedule as seen. Try again in a moment.",
      orderId: input.orderId,
    } satisfies MarkRescheduleSeenResponse);
  }
}
