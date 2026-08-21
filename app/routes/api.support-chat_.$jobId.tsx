import type { LoaderFunctionArgs } from "react-router";

import type { AgentBlock } from "../services/agent-core.server";
import { getSupportChatJob } from "../services/support-chat.server";
import { authenticate } from "../shopify.server";

// Poll endpoint for the support chat backend (agent-core phase 2). The
// customer-account extension calls POST /api/support-chat, gets a jobId back
// fast, then polls GET /api/support-chat/<jobId> until status is "done" (or
// "failed"). See support-chat.server.ts for the full WHY.
//
// Same auth + dest check as the POST route — a jobId alone is not proof of
// ownership; the job's threadId is re-checked against THIS request's
// verified customerGid so a guessed/leaked jobId can never surface another
// customer's conversation.

function hostFromDest(dest: unknown): string | null {
  if (typeof dest !== "string" || !dest.trim()) {
    return null;
  }
  try {
    const url = dest.startsWith("http://") || dest.startsWith("https://") ? new URL(dest) : new URL(`https://${dest}`);
    return url.host;
  } catch {
    return null;
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);

  const customerGid = typeof sessionToken.sub === "string" ? sessionToken.sub : "";
  if (!customerGid) {
    return cors(Response.json({ ok: false, reason: "not_signed_in" }));
  }

  const expectedShop = process.env.MESSENGER_SHOP?.trim();
  const tokenShop = hostFromDest(sessionToken.dest);
  if (!expectedShop || !tokenShop || tokenShop !== expectedShop) {
    console.warn(
      `[support-chat-poll] dest mismatch — expected=${expectedShop ?? "(unset)"} got=${tokenShop ?? "(unparsable)"}`,
    );
    return cors(Response.json({ ok: false, reason: "shop_mismatch" }));
  }

  const jobId = params.jobId;
  if (!jobId) {
    return cors(Response.json({ ok: false, reason: "not_found" }));
  }

  try {
    const job = await getSupportChatJob(jobId);
    // Never leak another customer's conversation: a job that exists but
    // belongs to a different thread answers identically to one that does
    // not exist at all.
    if (!job || job.threadId !== customerGid) {
      return cors(Response.json({ ok: false, reason: "not_found" }));
    }

    if (job.status === "pending") {
      return cors(Response.json({ ok: true, status: "pending" }));
    }

    if (job.status === "done") {
      let blocks: AgentBlock[] = [];
      try {
        blocks = job.blocksJson ? (JSON.parse(job.blocksJson) as AgentBlock[]) : [];
      } catch {
        console.warn(`[support-chat-poll] malformed blocksJson jobId=${jobId}`);
      }
      return cors(Response.json({ ok: true, status: "done", blocks }));
    }

    // status === "failed"
    return cors(Response.json({ ok: true, status: "failed", error: job.error ?? "Agent turn failed." }));
  } catch (error) {
    console.warn(
      `[support-chat-poll] threw jobId=${jobId}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return cors(Response.json({ ok: false, reason: "internal_error" }));
  }
};
