import type { ActionFunctionArgs } from "react-router";

import { verifyAppProxySignature } from "../lib/verify-app-proxy.server";
import { checkAndRecordAgentRateLimit } from "../services/agent-rate-limit.server";
import { enqueueSupportChatTask } from "../services/messenger-queue.server";
import {
  createSupportChatJob,
  ensureAnonymousSupportChatThread,
  failSupportChatJob,
  recordCustomerTurn,
} from "../services/support-chat.server";
import { runSupportChatTurn } from "../services/support-chat-turn.server";

// Storefront chat widget backend (theme app extension, agent-core phase 3).
// Anonymous, not gated behind customer login — auth is the App Proxy
// signature Shopify computes over the request, not a bearer token (see
// verify-app-proxy.server.ts). Verifying by hand instead of
// authenticate.public.appProxy skips a Prisma/Neon session lookup on every
// call — this route is polled every ~1.5s per active conversation, so
// cold-start avoidance matters more here than on apps.schedule-rules.products.ts.
//
// Same enqueue-then-poll shape as the customer-account support chat
// (api.support-chat.tsx) but REAL HTTP status codes instead of ADR-11's
// "always 200": ADR-11 exists because a customer-account extension's
// sandboxed fetch sees Cloudflare replace an origin 5xx body with generic
// HTML. App Proxy is a server-to-server Shopify-edge proxy —
// apps.schedule-rules.products.ts already returns real 401/404/502 today
// with no such problem, so that constraint does not apply here.
//
// POST /apps/schedule-rules/support-chat -> { ok:true, jobId } fast (<1s)
// GET  /apps/schedule-rules/support-chat/<jobId> -> poll (separate route file)

const MAX_MESSAGE_LENGTH = 4000; // STOREFRONT_CAPABILITIES.textLimit
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{36}$/i;

// Two layers, both checked BEFORE any SupportChat* table write, so an abuse
// burst only ever costs AgentRateLimit row updates, never a growing job
// backlog. conversationId is 100% client-controlled (a bot can
// localStorage.clear() before every request to mint a fresh one) — the IP
// layer is the backstop for that, not a defense against a distributed
// attacker (accepted as out of scope for v1, same posture ADR-20 already
// accepted for customer-account's total absence of turn throttling).
const CONVERSATION_RATE_LIMIT = 20;
const CONVERSATION_RATE_WINDOW_MS = 60 * 60_000;
const IP_RATE_LIMIT = 60;
const IP_RATE_WINDOW_MS = 60 * 60_000;

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxySignature(url, secret)) {
    return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const shop = url.searchParams.get("shop");
  const expectedShop = process.env.MESSENGER_SHOP?.trim();
  if (!shop || !expectedShop || shop !== expectedShop) {
    console.warn(`[storefront-chat] shop mismatch — expected=${expectedShop ?? "(unset)"} got=${shop ?? "(missing)"}`);
    return Response.json({ ok: false, reason: "shop_mismatch" }, { status: 401 });
  }

  let body: { conversationId?: unknown; message?: unknown };
  try {
    body = (await request.json()) as { conversationId?: unknown; message?: unknown };
  } catch {
    return Response.json({ ok: false, reason: "invalid_body" }, { status: 400 });
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    return Response.json({ ok: false, reason: "invalid_conversation_id" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json({ ok: false, reason: "empty_message" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ ok: false, reason: "message_too_long" }, { status: 400 });
  }

  const conversationLimit = await checkAndRecordAgentRateLimit(
    `conv:${conversationId}`,
    CONVERSATION_RATE_LIMIT,
    CONVERSATION_RATE_WINDOW_MS,
  );
  if (!conversationLimit.allowed) {
    return Response.json(
      { ok: false, reason: "rate_limited", retryAfterSeconds: conversationLimit.retryAfterSeconds },
      { status: 429 },
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) {
    const ipLimit = await checkAndRecordAgentRateLimit(`ip:${ip}`, IP_RATE_LIMIT, IP_RATE_WINDOW_MS);
    if (!ipLimit.allowed) {
      return Response.json(
        { ok: false, reason: "rate_limited", retryAfterSeconds: ipLimit.retryAfterSeconds },
        { status: 429 },
      );
    }
  }

  try {
    const threadId = await ensureAnonymousSupportChatThread({ conversationId, shop: expectedShop });
    await recordCustomerTurn(threadId, message);
    const { jobId } = await createSupportChatJob(threadId);

    const enqueued = await enqueueSupportChatTask({ jobId });
    if (enqueued.ok) {
      console.log(`[storefront-chat] enqueued jobId=${jobId} thread=${threadId}`);
      return Response.json({ ok: true, jobId });
    }

    if (enqueued.notConfigured) {
      // Local dev fallback — no queue, process inline (same posture as
      // api.support-chat.tsx). No retry here (walang queue), kaya ANY
      // failure marks the job failed; the HTTP answer still carries jobId
      // successfully minted.
      console.log(`[storefront-chat] queue not configured — processing jobId=${jobId} inline`);
      const verdict = await runSupportChatTurn({ jobId, threadId });
      if (verdict.status === "failed") {
        console.warn(`[storefront-chat] inline turn failed jobId=${jobId}: ${verdict.error}`);
        await failSupportChatJob(jobId, verdict.error);
      } else if (verdict.status === "skipped") {
        console.warn(`[storefront-chat] inline turn skipped jobId=${jobId} reason=${verdict.reason}`);
      }
      return Response.json({ ok: true, jobId });
    }

    console.warn(`[storefront-chat] enqueue failed jobId=${jobId}: ${enqueued.error}`);
    await failSupportChatJob(jobId, enqueued.error);
    return Response.json({ ok: false, reason: "enqueue_failed" }, { status: 502 });
  } catch (error) {
    console.warn(
      `[storefront-chat] action threw conversation=${conversationId}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return Response.json({ ok: false, reason: "internal_error" }, { status: 502 });
  }
};
