import type { LoaderFunctionArgs } from "react-router";

import { verifyAppProxySignature } from "../lib/verify-app-proxy.server";
import type { AgentBlock } from "../services/agent-core.server";
import { getSupportChatJob } from "../services/support-chat.server";

// Poll endpoint for the storefront chat widget (agent-core phase 3). Same
// shape as api.support-chat_.$jobId.tsx but App-Proxy-signed instead of
// customer-account-JWT-authenticated — see apps.schedule-rules.support-chat.ts
// for the full WHY.
//
// Ownership check: conversationId is a client-appended query param, included
// in what Shopify signs (same pattern as products.ts's client-appended
// collection/cursor/limit). A jobId alone is not proof of ownership — the
// job's threadId is re-derived from conversationId ("storefront:<id>") and
// compared, so a guessed/leaked jobId can never surface another visitor's
// conversation. Mismatch and missing-job answer IDENTICALLY (anti-enumeration,
// same posture as the customer-account poll route).

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxySignature(url, secret)) {
    return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const conversationId = url.searchParams.get("conversationId") ?? "";
  const jobId = params.jobId;
  if (!conversationId || !jobId) {
    return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
  }

  const expectedThreadId = `storefront:${conversationId}`;

  try {
    const job = await getSupportChatJob(jobId);
    if (!job || job.threadId !== expectedThreadId) {
      return Response.json({ ok: false, reason: "not_found" }, { status: 404 });
    }

    if (job.status === "pending") {
      return Response.json({ ok: true, status: "pending" });
    }

    if (job.status === "done") {
      let blocks: AgentBlock[] = [];
      try {
        blocks = job.blocksJson ? (JSON.parse(job.blocksJson) as AgentBlock[]) : [];
      } catch {
        console.warn(`[storefront-chat-poll] malformed blocksJson jobId=${jobId}`);
      }
      return Response.json({ ok: true, status: "done", blocks });
    }

    // status === "failed"
    return Response.json({
      ok: true,
      status: "failed",
      error: job.error ?? "Agent turn failed.",
    });
  } catch (error) {
    console.warn(
      `[storefront-chat-poll] threw jobId=${jobId}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return Response.json({ ok: false, reason: "internal_error" }, { status: 502 });
  }
};
