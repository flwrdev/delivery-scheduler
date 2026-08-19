import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  authenticateSidekickRequest,
  buildOrderNameQuery,
  fetchOrderDelivery,
  readJsonInput,
} from "../services/sidekick-tools.server";
import { authenticate } from "../shopify.server";

// POST /sidekick/tools/order-delivery — backs the `get_order_delivery` tool of
// the `delivery-sidekick-data` extension.
//
// READ-ONLY (docs/api.md § "Sidekick tool routes", docs/decisions.md ADR-18):
// one Admin GraphQL *query* by order name, returning exactly ONE order. No
// mutation is ever issued from this route, so it sits entirely outside the
// api.md §2 order write-path contract.
//
// Auth + response contract: identical to the other Sidekick tool routes —
// session-token `authenticate.admin`, `cors` for the sandbox origin, and
// ALWAYS 200 with `{ok:true|false}` (ADR-11).
export const action = async ({ request }: ActionFunctionArgs) => {
  // M-3: a session-store failure must not escape as a 5xx (ADR-11).
  const auth = await authenticateSidekickRequest(
    (req) => authenticate.admin(req),
    request,
  );
  if (!auth.ok) return auth.response;
  const { admin, cors } = auth.context;

  try {
    const parsedBody = await readJsonInput(request);
    if (!parsedBody.ok) {
      return cors(Response.json({ ok: false, error: parsedBody.error }));
    }

    const input = parsedBody.input;
    const name = buildOrderNameQuery(
      input.order_name ?? input.orderName ?? input.order ?? input.name,
    );
    if (!name.ok) {
      return cors(Response.json({ ok: false, error: name.error }));
    }

    const result = await fetchOrderDelivery(
      admin,
      name.searchQuery,
      name.normalizedName,
    );
    if (!result.ok) {
      return cors(Response.json({ ok: false, error: result.error }));
    }

    return cors(Response.json({ ok: true, order: result.order }));
  } catch (error) {
    console.error("Sidekick order-delivery tool failed:", error);
    return cors(
      Response.json({
        ok: false,
        error:
          "Could not look up that order's delivery schedule right now. Try again in a moment.",
      }),
    );
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticateSidekickRequest(
    (req) => authenticate.admin(req),
    request,
  );
  if (!auth.ok) return auth.response;
  const { cors } = auth.context;
  return cors(
    Response.json({
      ok: false,
      error: "This Sidekick tool endpoint only accepts POST.",
    }),
  );
};
