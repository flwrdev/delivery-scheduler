import type { LoaderFunctionArgs } from "react-router";

import { verifyAppProxySignature } from "../lib/verify-app-proxy.server";
import { checkDeliveryCoverage } from "../services/messenger-coverage.server";

// Storefront delivery-fee checker (delivery-fee-checker theme extension).
//
// A SECOND caller for checkDeliveryCoverage() — the same pure lookup the
// FlowerBot agent uses via agent-tools.server.ts, so the storefront quote and
// the chat quote can never drift. This route adds NO logic of its own: it
// only adapts the agent-shaped result into a UI-shaped payload. Any future
// display tweak belongs HERE, never in messenger-coverage.server.ts (that
// service is shared with the agent and locked by
// test/messenger-coverage.server.test.ts).
//
// Same hand-rolled App Proxy HMAC auth as apps.schedule-rules.widget-config.ts
// — skips the Prisma session lookup, which matters because shoppers can type
// into the field repeatedly. Pure in-process: no DB, no external API.
//
// GET /apps/schedule-rules/coverage?q=Makati
//   -> { ok:true, covered:true, areas:[{label,feePhp,estimate,provincial}], ... }

const MAX_QUERY_LENGTH = 60;
const MAX_AREAS_SHOWN = 5;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxySignature(url, secret)) {
    return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const shop = url.searchParams.get("shop");
  const expectedShop = process.env.MESSENGER_SHOP?.trim();
  if (!shop || !expectedShop || shop !== expectedShop) {
    console.warn(
      `[coverage] shop mismatch — expected=${expectedShop ?? "(unset)"} got=${shop ?? "(missing)"}`,
    );
    return Response.json({ ok: false, reason: "shop_mismatch" }, { status: 401 });
  }

  // One field, two kinds of input: "1200" is a zip, "Makati" is an area.
  // Digits-only goes to `zip`, anything else to `area` — the service already
  // falls back from one to the other, so a mixed "BGC 1634" still resolves.
  const raw = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (!raw) {
    return Response.json({ ok: false, error: "Type a city, barangay, or ZIP code." });
  }
  const isZip = /^\d{4}$/.test(raw);

  const result = checkDeliveryCoverage(
    isZip ? { zip: raw } : { zip: raw.replace(/\D+/g, ""), area: raw },
  );

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error });
  }

  if (!result.covered) {
    return Response.json(
      { ok: true, covered: false, note: result.note },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  }

  // Adapter layer. `feeNote` is deliberately dropped — it is an instruction
  // written for the LLM, not copy a shopper should ever read.
  const areas = result.matches.slice(0, MAX_AREAS_SHOWN).map((match) => ({
    label: match.zip ? `${match.area}, ${match.city} (${match.zip})` : match.city,
    feePhp: match.estimatedFeePhp ?? match.flatFeePhp ?? null,
    estimate: match.estimatedFeePhp != null,
    provincial: Boolean(match.provincial),
  }));

  return Response.json(
    {
      ok: true,
      covered: true,
      areas,
      ...(result.provincialNote ? { provincialNote: result.provincialNote } : {}),
      freeShippingAbovePhp: 2500,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
};
