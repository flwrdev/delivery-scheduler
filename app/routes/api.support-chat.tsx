import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { enqueueSupportChatTask } from "../services/messenger-queue.server";
import {
  createSupportChatJob,
  ensureSupportChatThread,
  failSupportChatJob,
  recordCustomerTurn,
} from "../services/support-chat.server";
import { runSupportChatTurn } from "../services/support-chat-turn.server";
import { authenticate } from "../shopify.server";

// Support chat backend for the Shopify customer-account chat extension
// (agent-core phase 2). Enqueue-then-poll, never a long-held request — see
// support-chat.server.ts for the full WHY.
//
// POST /api/support-chat            -> { ok:true, jobId } fast (<1s)
// GET  /api/support-chat/<jobId>    -> poll (separate route file)
//
// Auth: authenticate.public.customerAccount(request) verifies the session
// token Shopify's customer-account runtime attaches to every extension
// request. SECURITY RULE: the customer id comes ONLY from the verified
// token's `sub` claim — never from the request body or query string, even if
// present, so a forged body can never impersonate another customer.
//
// ADR-11: every failure path returns 200 + { ok:false, reason } — never a
// thrown 5xx (Cloudflare replaces an origin 502/504 body with its own HTML
// and breaks the embedded fetcher). Auth failures are the one exception:
// authenticate.public.customerAccount throws its OWN Response (401/204 for
// OPTIONS) before our handler runs at all — that is Shopify's contract, not
// an upstream failure we're relaying.

const MAX_MESSAGE_LENGTH = 4000;

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

// Answers the CORS preflight — authenticate.public.customerAccount handles
// OPTIONS itself (throws a 204 with CORS headers) before this body runs.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.customerAccount(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.customerAccount(request);

  const customerGid = typeof sessionToken.sub === "string" ? sessionToken.sub : "";
  if (!customerGid) {
    return cors(Response.json({ ok: false, reason: "not_signed_in" }));
  }

  const expectedShop = process.env.MESSENGER_SHOP?.trim();
  const tokenShop = hostFromDest(sessionToken.dest);
  if (!expectedShop || !tokenShop || tokenShop !== expectedShop) {
    console.warn(
      `[support-chat] dest mismatch — expected=${expectedShop ?? "(unset)"} got=${tokenShop ?? "(unparsable)"}`,
    );
    return cors(Response.json({ ok: false, reason: "shop_mismatch" }));
  }

  let body: { message?: unknown };
  try {
    body = (await request.json()) as { message?: unknown };
  } catch {
    return cors(Response.json({ ok: false, reason: "invalid_body" }));
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return cors(Response.json({ ok: false, reason: "empty_message" }));
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return cors(Response.json({ ok: false, reason: "message_too_long" }));
  }

  try {
    await ensureSupportChatThread({ customerGid, shop: expectedShop });
    await recordCustomerTurn(customerGid, message);
    const { jobId } = await createSupportChatJob(customerGid);

    const enqueued = await enqueueSupportChatTask({ jobId });
    if (enqueued.ok) {
      console.log(`[support-chat] enqueued jobId=${jobId} thread=${customerGid}`);
      return cors(Response.json({ ok: true, jobId }));
    }

    if (enqueued.notConfigured) {
      // Local dev fallback — no queue, process inline (same posture as
      // webhooks.messenger.ts). The extension still polls, but the job is
      // already done by the time it does.
      //
      // Same shared turn the Cloud Tasks worker runs, guards included — this
      // path used to call runAgentTurn directly and so missed the
      // order-commitment interception entirely. There is no retry here (walang
      // queue), kaya ANY failure marks the job failed; the HTTP answer stays
      // 200 + ok:true because the jobId itself was minted successfully (ADR-11).
      console.log(`[support-chat] queue not configured — processing jobId=${jobId} inline`);
      const verdict = await runSupportChatTurn({ jobId, threadId: customerGid });
      if (verdict.status === "failed") {
        console.warn(`[support-chat] inline turn failed jobId=${jobId}: ${verdict.error}`);
        await failSupportChatJob(jobId, verdict.error);
      } else if (verdict.status === "skipped") {
        console.warn(`[support-chat] inline turn skipped jobId=${jobId} reason=${verdict.reason}`);
      }
      return cors(Response.json({ ok: true, jobId }));
    }

    console.warn(`[support-chat] enqueue failed jobId=${jobId}: ${enqueued.error}`);
    await failSupportChatJob(jobId, enqueued.error);
    return cors(Response.json({ ok: false, reason: "enqueue_failed" }));
  } catch (error) {
    console.warn(
      `[support-chat] action threw thread=${customerGid}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return cors(Response.json({ ok: false, reason: "internal_error" }));
  }
};
