import type { LoaderFunctionArgs } from "react-router";

import { verifyAppProxySignature } from "../lib/verify-app-proxy.server";
import { loadWidgetConfig } from "../services/widget-config.server";

// Storefront chat widget config (agent-core phase 3 addendum, 2026-08-23):
// serves the merchant-editable greeting/bubble-color/support-phone/starter-
// chip copy set on the Messenger admin page. Same App Proxy HMAC auth as
// apps.schedule-rules.support-chat.ts — verified by hand (not
// authenticate.public.appProxy) to skip a Prisma session-storage lookup,
// which matters more here since this is called on EVERY storefront page
// load (the widget script fetches it before mounting), not once per chat
// turn.
//
// GET /apps/schedule-rules/widget-config -> { ok:true, greeting, bubbleColor,
// supportPhone, chips:[{action:"track_order",label}, {label,message}x3] }

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxySignature(url, secret)) {
    return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const shop = url.searchParams.get("shop");
  const expectedShop = process.env.MESSENGER_SHOP?.trim();
  if (!shop || !expectedShop || shop !== expectedShop) {
    console.warn(`[widget-config] shop mismatch — expected=${expectedShop ?? "(unset)"} got=${shop ?? "(missing)"}`);
    return Response.json({ ok: false, reason: "shop_mismatch" }, { status: 401 });
  }

  const facts = await loadWidgetConfig(expectedShop);

  return Response.json(
    {
      ok: true,
      greeting: facts.greeting,
      bubbleColor: facts.bubbleColor,
      supportPhone: facts.supportPhone,
      chips: [
        { action: "track_order", label: facts.trackLabel },
        ...facts.chips.map((chip) => ({ label: chip.label, message: chip.message })),
      ],
      panelBg: facts.panelBg,
      textColor: facts.textColor,
      mutedColor: facts.mutedColor,
      borderColor: facts.borderColor,
      panelSize: facts.panelSize,
      cornerRadius: facts.cornerRadius,
      position: facts.position,
      disclaimerText: facts.disclaimerText,
      showDisclaimer: facts.showDisclaimer,
      autoHideBubble: facts.autoHideBubble,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
};
