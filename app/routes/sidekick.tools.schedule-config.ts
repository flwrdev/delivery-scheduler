import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { getScheduleRulesWithHealth } from "../services/schedule-rules.server";
import {
  authenticateSidekickRequest,
  readJsonInput,
  summarizeScheduleConfig,
} from "../services/sidekick-tools.server";
import { authenticate } from "../shopify.server";

// POST /sidekick/tools/schedule-config — backs the
// `get_schedule_config_summary` tool of the `delivery-sidekick-data` extension.
//
// READ-ONLY (docs/api.md § "Sidekick tool routes", docs/decisions.md ADR-18).
// Deliberately uses `getScheduleRulesWithHealth` and NOT the booked-count
// loader: the config answer needs no live Admin order scan, so this is the
// cheap tool and `get_delivery_booked_counts` is the expensive one.
//
// Auth + response contract: session-token `authenticate.admin`, `cors` for the
// sandbox origin, ALWAYS 200 with `{ok:true|false}` (ADR-11).
export const action = async ({ request }: ActionFunctionArgs) => {
  // M-3: a session-store failure must not escape as a 5xx (ADR-11).
  const auth = await authenticateSidekickRequest(
    (req) => authenticate.admin(req),
    request,
  );
  if (!auth.ok) return auth.response;
  const { session, cors } = auth.context;

  try {
    const parsedBody = await readJsonInput(request);
    if (!parsedBody.ok) {
      return cors(Response.json({ ok: false, error: parsedBody.error }));
    }

    const { rules, configHealth, version } = await getScheduleRulesWithHealth(
      session.shop,
    );

    return cors(
      Response.json({
        ok: true,
        ...summarizeScheduleConfig(rules, configHealth, version),
      }),
    );
  } catch (error) {
    console.error("Sidekick schedule-config tool failed:", error);
    return cors(
      Response.json({
        ok: false,
        error:
          "Could not load the delivery schedule configuration right now. Try again in a moment.",
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
