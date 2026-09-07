import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

const TIME_SLOTS = ["9AM-12PM", "12PM-3PM", "3PM-6PM", "6PM-11PM"];
const SOURCES = ["messenger", "instagram"];

type VariantOption = { id: string; label: string; price: string };

const VARIANTS_QUERY = `#graphql
  query VariantsForForm($after: String) {
    productVariants(first: 250, after: $after, query: "product_status:active") {
      nodes { id title price product { title } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const DRAFT_CREATE = `#graphql
  mutation CreateMessengerDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;

const DRAFT_COMPLETE = `#graphql
  mutation CompleteMessengerDraft($id: ID!, $source: String) {
    draftOrderComplete(id: $id, sourceName: $source) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const variants: VariantOption[] = [];
  let after: string | null = null;
  do {
    const res: Response = await admin.graphql(VARIANTS_QUERY, { variables: { after } });
    const data = (await res.json()).data.productVariants;
    for (const v of data.nodes) {
      const label = v.title === "Default Title" ? v.product.title : `${v.product.title} / ${v.title}`;
      variants.push({ id: v.id, label, price: v.price });
    }
    after = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  } while (after);
  variants.sort((a, b) => a.label.localeCompare(b.label));
  return Response.json({ variants, timeSlots: TIME_SLOTS });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const f = await request.formData();
  const s = (k: string) => (f.get(k) as string | null)?.trim() ?? "";

  const variantId = s("variantId");
  const quantity = Math.max(1, parseInt(s("quantity") || "1", 10));
  const deliveryDate = s("deliveryDate");
  const deliveryTime = s("deliveryTime");
  const source = SOURCES.includes(s("source")) ? s("source") : "messenger";
  const paid = s("paid") === "on";
  const email = s("email");
  const phone = s("phone");

  if (!variantId || !deliveryDate || !deliveryTime || !s("recipientName") || !s("address1") || !s("city")) {
    return Response.json({ error: "Kulang ang required fields: product, delivery date, time slot, recipient name, address, city." }, { status: 400 });
  }
  if (!email && !phone) {
    return Response.json({ error: "Kailangan ng email o phone para may confirmation at para magamit ang tracking page." }, { status: 400 });
  }

  const [firstName, ...rest] = s("recipientName").split(" ");
  const deliveryFee = parseFloat(s("deliveryFee") || "0");
  const noteLines = [
    `Source: ${source}`,
    s("customerName") ? `Ordered by: ${s("customerName")}` : null,
    s("gcashRef") ? `GCash ref: ${s("gcashRef")}` : null,
    s("note") ? `Notes: ${s("note")}` : null,
  ].filter(Boolean);

  const input = {
    lineItems: [{ variantId, quantity }],
    email: email || undefined,
    phone: phone || undefined,
    shippingAddress: {
      firstName,
      lastName: rest.join(" ") || undefined,
      address1: s("address1"),
      address2: s("address2") || undefined,
      city: s("city"),
      phone: s("recipientPhone") || phone || undefined,
      countryCode: "PH",
    },
    customAttributes: [
      { key: "Delivery Date", value: deliveryDate },
      { key: "Delivery Time", value: deliveryTime },
      { key: "Card Message", value: s("cardMessage") },
    ],
    tags: [deliveryDate, deliveryTime, `source:${source}`],
    shippingLine: {
      title: "LALAMOVE",
      priceWithCurrency: { amount: isNaN(deliveryFee) ? 0 : deliveryFee, currencyCode: "PHP" },
    },
    note: noteLines.join("\n"),
    sourceName: source,
  };

  const createRes = await admin.graphql(DRAFT_CREATE, { variables: { input } });
  const create = (await createRes.json()).data.draftOrderCreate;
  if (create.userErrors.length) {
    return Response.json({ error: create.userErrors.map((e: any) => e.message).join("; ") }, { status: 400 });
  }
  const draft = create.draftOrder;

  if (!paid) {
    return Response.json({
      ok: true,
      mode: "draft",
      draftName: draft.name,
      total: draft.totalPriceSet.shopMoney.amount,
      invoiceUrl: draft.invoiceUrl,
    });
  }

  const completeRes = await admin.graphql(DRAFT_COMPLETE, { variables: { id: draft.id, source } });
  const complete = (await completeRes.json()).data.draftOrderComplete;
  if (complete.userErrors.length) {
    return Response.json({ error: complete.userErrors.map((e: any) => e.message).join("; ") }, { status: 400 });
  }
  return Response.json({
    ok: true,
    mode: "order",
    orderName: complete.draftOrder.order.name,
    orderId: complete.draftOrder.order.id,
    total: draft.totalPriceSet.shopMoney.amount,
  });
}

export default function MessengerOrder() {
  const { variants, timeSlots } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as any;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const orderNumber = result?.orderName?.replace("#", "");
  const chatReply = orderNumber
    ? `Confirmed na po ang order ninyo. Order number: ${orderNumber}. May confirmation email na rin po kayo. Pwede ninyong i-check ang status anytime dito: https://flowercart.store/pages/track?order=${orderNumber}`
    : "";

  const field = { display: "grid", gap: 4, marginBottom: 12 } as const;
  const input = { padding: 8, border: "1px solid #c9cccf", borderRadius: 6, font: "inherit" } as const;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 24, font: "14px system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Messenger order</h1>

      {result?.error && (
        <div style={{ background: "#fed3d1", padding: 12, borderRadius: 8, marginBottom: 16 }}>{result.error}</div>
      )}
      {result?.ok && result.mode === "order" && (
        <div style={{ background: "#cdfed3", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <strong>Order {result.orderName} created and marked as paid. Total PHP {result.total}.</strong>
          <p style={{ margin: "8px 0 4px" }}>Copy this to the chat:</p>
          <textarea readOnly rows={4} style={{ ...input, width: "100%" }} value={chatReply} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {result?.ok && result.mode === "draft" && (
        <div style={{ background: "#e0f0ff", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <strong>Draft {result.draftName} saved. Total PHP {result.total}.</strong>
          <p style={{ margin: "8px 0 0" }}>
            Hindi pa marked as paid. Kapag na-verify ang GCash, buksan ang draft sa Shopify admin at i-click ang Mark as paid,
            o i-send ang invoice link: <a href={result.invoiceUrl} target="_blank" rel="noreferrer">{result.invoiceUrl}</a>
          </p>
        </div>
      )}

      <Form method="post">
        <label style={field}>Source
          <select name="source" style={input}>{SOURCES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </label>
        <label style={field}>Product
          <select name="variantId" required style={input}>
            <option value="">Pumili ng bouquet</option>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.label} (PHP {v.price})</option>)}
          </select>
        </label>
        <label style={field}>Quantity<input name="quantity" type="number" min={1} defaultValue={1} style={input} /></label>
        <label style={field}>Customer name (nag-order)<input name="customerName" style={input} /></label>
        <label style={field}>Customer email<input name="email" type="email" style={input} /></label>
        <label style={field}>Customer phone<input name="phone" style={input} /></label>
        <label style={field}>Recipient name<input name="recipientName" required style={input} /></label>
        <label style={field}>Recipient phone<input name="recipientPhone" style={input} /></label>
        <label style={field}>Address line 1<input name="address1" required style={input} /></label>
        <label style={field}>Address line 2<input name="address2" style={input} /></label>
        <label style={field}>City<input name="city" required style={input} /></label>
        <label style={field}>Delivery date<input name="deliveryDate" type="date" required style={input} /></label>
        <label style={field}>Time slot
          <select name="deliveryTime" required style={input}>{timeSlots.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </label>
        <label style={field}>Card message<textarea name="cardMessage" rows={3} style={input} /></label>
        <label style={field}>Delivery fee (PHP)<input name="deliveryFee" type="number" min={0} step="1" defaultValue={0} style={input} /></label>
        <label style={field}>GCash reference number<input name="gcashRef" style={input} /></label>
        <label style={field}>Internal note<textarea name="note" rows={2} style={input} /></label>
        <label style={{ ...field, gridTemplateColumns: "auto 1fr", alignItems: "center" }}>
          <input name="paid" type="checkbox" /> Bayad na at na-verify ang GCash (gagawing paid order agad)
        </label>
        <button type="submit" disabled={busy} style={{ ...input, background: "#303030", color: "#fff", cursor: "pointer" }}>
          {busy ? "Saving..." : "Create order"}
        </button>
      </Form>
    </div>
  );
}
