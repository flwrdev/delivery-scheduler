import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { getScheduleRulesDetailed } from "../services/schedule-rules.server";
import {
  authenticateSidekickRequest,
  parseBookedCountsInput,
  readJsonInput,
  summarizeBookedCounts,
} from "../services/sidekick-tools.server";
import { authenticate } from "../shopify.server";

// POST /sidekick/tools/booked-counts — backs the `get_delivery_booked_counts`
// tool of the `delivery-sidekick-data` extension.
//
// READ-ONLY (docs/api.md § "Sidekick tool routes", docs/decisions.md ADR-18):
// zero order writes, zero delivery-state writes, no mutations. It only reads
// `getScheduleRulesDetailed`, the same loader the admin scheduler already uses.
//
// Auth: `authenticate.admin(request)` — the Sidekick sandbox attaches a session
// token Authorization header, which the shopify-app-react-router middleware
// exchanges the same way it does for embedded admin fetches. NEW CALLER, same
// mechanism. The `cors` helper is applied because the sandbox is a different
// origin from the app.
//
// Response contract: ALWAYS 200. Upstream failures answer `200 + {ok:false}`
// (ADR-11 — Cloudflare replaces origin 5xx bodies and breaks the caller).
export const action = async ({ request }: ActionFunctionArgs) => {
  // M-3: a session-store failure must not escape as a 5xx (ADR-11).
  const auth = await authenticateSidekickRequest(
    (req) => authenticate.admin(req),
    request,
  );
  if (!auth.ok) return auth.response;
  const { admin, session, cors } = auth.context;

  try {
    const parsedBody = await readJsonInput(request);
    if (!parsedBody.ok) {
      return cors(Response.json({ ok: false, error: parsedBody.error }));
    }

    const parsedInput = parseBookedCountsInput(parsedBody.input);
    if (!parsedInput.ok) {
      return cors(Response.json({ ok: false, error: parsedInput.error }));
    }

    const detailed = await getScheduleRulesDetailed(session.shop, admin);
    return cors(
      Response.json({
        ok: true,
        ...summarizeBookedCounts(detailed, parsedInput.query),
      }),
    );
  } catch (error) {
    console.error("Sidekick booked-counts tool failed:", error);
    return cors(
      Response.json({
        ok: false,
        error:
          "Could not load delivery booked counts right now. Try again in a moment.",
      }),
    );
  }
};

// GET is not part of the tool contract; answer in the same shape rather than
// letting React Router raise a 405 the sandbox would surface as an error page.
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
