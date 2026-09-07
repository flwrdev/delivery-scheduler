import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { lookupOrder, normalizeOrderNumber } from "../lib/order-tracking.server";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

function manilaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) return Response.json({ error: "unavailable" }, { status: 503 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return Response.json({ error: "too_many" }, { status: 429 });

  const url = new URL(request.url);
  const orderNumber = normalizeOrderNumber(url.searchParams.get("order") ?? "");
  const contact = (url.searchParams.get("contact") ?? "").trim();
  if (!orderNumber || contact.length < 6) return Response.json({ error: "invalid" }, { status: 400 });

  const result = await lookupOrder(
    (q, opts) => admin.graphql(q, opts),
    orderNumber,
    contact,
    manilaToday(),
  );

  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
