import type { LoaderFunctionArgs } from "react-router";

import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The storefront app proxy reuses the shared rules service so theme code and app
  // surfaces read the same delivery window, blackout, and capacity contract.
  const { admin, session } = await authenticate.public.appProxy(request);
  const shop = session?.shop;
  const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin);

  return Response.json(scheduleRules, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
};
