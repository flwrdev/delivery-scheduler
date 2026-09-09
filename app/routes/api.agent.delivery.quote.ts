import type { LoaderFunctionArgs } from "react-router";

import { agentErrorResponse, agentJsonResponse, gateAgentRequest } from "../lib/verify-agent-token.server";
import { AgentApiError, getAgentDeliveryQuote } from "../services/agent-api.server";

// GET /api/agent/delivery/quote?city=Imus&zip=4103&date=2026-09-12 — Meta
// agent tool: coverage + fee estimate, COD availability, and slot
// availability for an optional date.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const gate = gateAgentRequest(request, "quote");
  if (gate) return gate;

  const url = new URL(request.url);
  try {
    const result = await getAgentDeliveryQuote({
      city: url.searchParams.get("city") ?? url.searchParams.get("q") ?? undefined,
      zip: url.searchParams.get("zip") ?? undefined,
      province: url.searchParams.get("province") ?? undefined,
      date: url.searchParams.get("date") ?? undefined,
    });
    return agentJsonResponse(result);
  } catch (error) {
    if (error instanceof AgentApiError) {
      return agentErrorResponse(error.status, error.code, error.message, error.extra);
    }
    console.error(`[agent-api] quote failed: ${error instanceof Error ? error.message : String(error)}`);
    return agentErrorResponse(500, "internal_error", "May problema sa pag-quote. Subukan ulit.");
  }
};
