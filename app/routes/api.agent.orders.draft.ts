import type { ActionFunctionArgs } from "react-router";

import { agentErrorResponse, agentJsonResponse, gateAgentRequest } from "../lib/verify-agent-token.server";
import { AgentApiError, createAgentDraftOrder, parseCreateDraftInput } from "../services/agent-api.server";

// POST /api/agent/orders/draft — Meta agent tool: create a draft order (or a
// COD order) for a Messenger customer. Bearer token auth; idempotent per key.

export const loader = async () => {
  return agentErrorResponse(405, "method_not_allowed", "Use POST.");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return agentErrorResponse(405, "method_not_allowed", "Use POST.");
  }
  const gate = gateAgentRequest(request, "draft");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return agentErrorResponse(400, "invalid_json", "Request body must be JSON.");
  }

  try {
    const input = parseCreateDraftInput(body);
    const result = await createAgentDraftOrder(input);
    return agentJsonResponse(result, result.reused ? 200 : 201);
  } catch (error) {
    if (error instanceof AgentApiError) {
      return agentErrorResponse(error.status, error.code, error.message, error.extra);
    }
    console.error(`[agent-api] draft failed: ${error instanceof Error ? error.message : String(error)}`);
    return agentErrorResponse(500, "internal_error", "May problema sa pag-create ng order. Subukan ulit.");
  }
};
