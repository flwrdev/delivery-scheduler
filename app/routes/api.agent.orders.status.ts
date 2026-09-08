import type { LoaderFunctionArgs } from "react-router";

import { agentErrorResponse, agentJsonResponse, gateAgentRequest } from "../lib/verify-agent-token.server";
import { AgentApiError, getAgentOrderStatus } from "../services/agent-api.server";

// GET /api/agent/orders/status?order=4350&email=<email> — Meta agent tool:
// order stage, delivery date/slot, tracking and status page links. Works for
// every Shopify order (website or chat); the email must match the order.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const gate = gateAgentRequest(request, "status");
  if (gate) return gate;

  const url = new URL(request.url);
  try {
    const result = await getAgentOrderStatus(url.searchParams.get("order") ?? "", url.searchParams.get("email") ?? "");
    return agentJsonResponse(result);
  } catch (error) {
    if (error instanceof AgentApiError) {
      return agentErrorResponse(error.status, error.code, error.message, error.extra);
    }
    console.error(`[agent-api] status failed: ${error instanceof Error ? error.message : String(error)}`);
    return agentErrorResponse(500, "internal_error", "May problema sa pag-check ng order. Subukan ulit.");
  }
};
