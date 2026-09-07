type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

export type TrackingResult = {
  found: true;
  orderName: string;
  stage: "waiting_payment" | "confirmed" | "preparing" | "on_the_way" | "own_rider" | "delivered" | "cancelled";
  headline: string;
  detail: string;
  deliveryDate: string | null;
  deliveryTime: string | null;
  trackingUrl: string | null;
  items: string[];
} | { found: false };

const ORDER_QUERY = `#graphql
  query TrackOrder($q: String!) {
    orders(first: 1, query: $q) {
      nodes {
        name
        email
        phone
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        customAttributes { key value }
        shippingAddress { phone }
        fulfillments {
          status
          displayStatus
          trackingInfo { url }
        }
        lineItems(first: 10) { nodes { title quantity } }
      }
    }
  }
`;

export function normalizeOrderNumber(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length >= 3 && digits.length <= 8 ? digits : null;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.startsWith("63") ? "0" + digits.slice(2) : digits;
}

function contactMatches(order: any, contact: string): boolean {
  const c = contact.trim().toLowerCase();
  if (c.includes("@")) return (order.email ?? "").toLowerCase() === c;
  const want = normalizePhone(c);
  if (want.length < 10) return false;
  const candidates = [order.phone, order.shippingAddress?.phone].filter(Boolean).map(normalizePhone);
  return candidates.some((p) => p.endsWith(want) || want.endsWith(p));
}

export async function lookupOrder(
  graphql: AdminGraphql,
  orderNumber: string,
  contact: string,
  today: string,
): Promise<TrackingResult> {
  const res = await graphql(ORDER_QUERY, { variables: { q: `name:${orderNumber}` } });
  const json = await res.json();
  const order = json?.data?.orders?.nodes?.[0];
  if (!order || !contactMatches(order, contact)) return { found: false };

  const attr = (k: string) => order.customAttributes?.find((a: any) => a.key === k)?.value ?? null;
  const deliveryDate = attr("Delivery Date");
  const deliveryTime = attr("Delivery Time");
  const items = order.lineItems.nodes.map((li: any) => (li.quantity > 1 ? `${li.title} x${li.quantity}` : li.title));

  const active = order.fulfillments.filter((f: any) => f.status !== "CANCELLED");
  const latest = active[active.length - 1];
  const trackingUrl = latest?.trackingInfo?.find((t: any) => t.url)?.url ?? null;
  const when = [deliveryDate, deliveryTime].filter(Boolean).join(", ");

  let stage: Extract<TrackingResult, { found: true }>["stage"];
  let headline: string;
  let detail: string;

  if (order.cancelledAt) {
    stage = "cancelled";
    headline = "Order cancelled";
    detail = "This order was cancelled. Message us on Messenger if you did not request this.";
  } else if (order.displayFinancialStatus !== "PAID" && order.displayFinancialStatus !== "PARTIALLY_REFUNDED") {
    stage = "waiting_payment";
    headline = "Waiting for payment";
    detail = "Your delivery slot is locked only once payment is verified. Send us your proof of payment on Messenger.";
  } else if (latest?.displayStatus === "DELIVERED" || order.displayFulfillmentStatus === "FULFILLED" && latest?.displayStatus === "DELIVERED") {
    stage = "delivered";
    headline = "Delivered";
    detail = "Your flowers have been delivered. Thank you for ordering from FlowerCart.";
  } else if (latest && trackingUrl) {
    stage = "on_the_way";
    headline = "On the way";
    detail = "Your rider is on the way. Open the live tracking link to see where they are.";
  } else if (latest) {
    stage = "own_rider";
    headline = "On the way with our own rider";
    detail = "This delivery is handled by our in-house rider, so there is no live map. It will arrive within your chosen time slot.";
  } else if (deliveryDate && deliveryDate === today) {
    stage = "preparing";
    headline = "Being prepared for today";
    detail = `Your bouquet is being arranged for delivery today${deliveryTime ? `, ${deliveryTime}` : ""}. You will get an email with the tracking link once it is dispatched.`;
  } else {
    stage = "confirmed";
    headline = "Confirmed and scheduled";
    detail = when
      ? `Your order is confirmed for ${when}. We will prepare it on the delivery day and email you the tracking link once dispatched.`
      : "Your order is confirmed. We will email you the tracking link once dispatched.";
  }

  return { found: true, orderName: order.name, stage, headline, detail, deliveryDate, deliveryTime, trackingUrl, items };
}
