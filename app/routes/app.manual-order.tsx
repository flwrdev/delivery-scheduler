import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { looksLikeSummary, parseOrderSummary } from "../lib/parse-order-summary";

const TIME_SLOTS = ["9AM-12PM", "12PM-3PM", "3PM-6PM", "6PM-11PM"];
const SOURCES = ["messenger", "instagram"];

type VariantOption = { id: string; label: string; price: string };
type UserError = { field: string[] | null; message: string };
type ActionResult = {
  error?: string;
  ok?: true;
  mode?: "draft" | "order";
  draftName?: string;
  orderName?: string;
  orderId?: string;
  total?: string;
  invoiceUrl?: string;
};

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
      province: s("province") || undefined,
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
    return Response.json({ error: create.userErrors.map((e: UserError) => e.message).join("; ") }, { status: 400 });
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
    return Response.json({ error: complete.userErrors.map((e: UserError) => e.message).join("; ") }, { status: 400 });
  }
  return Response.json({
    ok: true,
    mode: "order",
    orderName: complete.draftOrder.order.name,
    orderId: complete.draftOrder.order.id,
    total: draft.totalPriceSet.shopMoney.amount,
  });
}

const EMPTY_FORM: Record<string, string> = { source: "messenger", quantity: "1", deliveryFee: "0" };

export default function ManualOrder() {
  const { variants, timeSlots } = useLoaderData() as { variants: VariantOption[]; timeSlots: string[] };
  const result = useActionData() as ActionResult | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const [values, setValues] = useState<Record<string, string>>(EMPTY_FORM);
  const [summary, setSummary] = useState("");
  const [pastedTotal, setPastedTotal] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const bind = (name: string) => ({
    name,
    value: values[name] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValues((prev) => ({ ...prev, [name]: e.target.value })),
  });

  // Fills only the fields present in the pasted text; everything else is kept as-is.
  const applySummary = (text: string) => {
    const parsed = parseOrderSummary(text, variants);
    setValues((prev) => ({ ...prev, ...parsed.values }));
    setPastedTotal(parsed.pastedTotal);
    setWarnings(parsed.warnings);
  };

  const onSummaryChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSummary(e.target.value);
    applySummary(e.target.value);
  };

  // A "Label: value" paste into any single input is routed through the parser instead of landing raw.
  const onFieldPaste = (e: React.ClipboardEvent<HTMLElement>) => {
    const text = e.clipboardData.getData("text");
    if (!looksLikeSummary(text)) return;
    e.preventDefault();
    applySummary(text);
  };

  const computedTotal = useMemo(() => {
    const variant = variants.find((v) => v.id === values.variantId);
    if (!variant) return null;
    const qty = Math.max(1, parseInt(values.quantity || "1", 10) || 1);
    const fee = parseFloat(values.deliveryFee || "0") || 0;
    return parseFloat(variant.price) * qty + fee;
  }, [variants, values.variantId, values.quantity, values.deliveryFee]);

  const totalMismatch =
    pastedTotal !== null && computedTotal !== null && Math.abs(pastedTotal - computedTotal) > 0.005;

  const field = { display: "grid", gap: 4, marginBottom: 12 } as const;
  const input = { padding: 8, border: "1px solid #c9cccf", borderRadius: 6, font: "inherit" } as const;
  const peso = (n: number) => `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 24, font: "14px system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Manual order</h1>

      {result?.error && (
        <div style={{ background: "#fed3d1", padding: 12, borderRadius: 8, marginBottom: 16 }}>{result.error}</div>
      )}
      {result?.ok && result.mode === "order" && (
        <div style={{ background: "#cdfed3", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <strong>Order {result.orderName} created and marked as paid. Total PHP {result.total}.</strong>
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

      <label style={{ ...field, marginBottom: 20 }}>
        <span>Paste order summary (Messenger / Instagram)</span>
        <textarea
          value={summary}
          onChange={onSummaryChange}
          rows={8}
          style={{ ...input, fontFamily: "ui-monospace, monospace" }}
          placeholder={"Product: **Autumn Morning**\nRecipient: **Maria Santos**\nContact: **0912 345 6789**\n..."}
        />
        <span style={{ color: "#6d7175" }}>
          Auto-fill ang form mula sa pasted summary. Pwede ring i-paste ang isang linya (hal. Address: ...) diretso sa kahit anong field.
        </span>
      </label>

      {warnings.length > 0 && (
        <div style={{ background: "#ffea8a", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}
      {pastedTotal !== null && computedTotal !== null && (
        <div style={{ background: totalMismatch ? "#ffea8a" : "#e0f0ff", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          Total sa summary: <strong>{peso(pastedTotal)}</strong> · Computed (product × qty + fee): <strong>{peso(computedTotal)}</strong>
          {totalMismatch && <div>Hindi tugma ang total. I-check ang product, quantity, o delivery fee bago i-create.</div>}
        </div>
      )}

      <Form method="post" onPaste={onFieldPaste}>
        <label style={field}>Source
          <select {...bind("source")} style={input}>{SOURCES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </label>
        <label style={field}>Product
          <select {...bind("variantId")} required style={input}>
            <option value="">Pumili ng bouquet</option>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.label} (PHP {v.price})</option>)}
          </select>
        </label>
        <label style={field}>Quantity<input {...bind("quantity")} type="number" min={1} style={input} /></label>
        <label style={field}>Customer name (nag-order)<input {...bind("customerName")} style={input} /></label>
        <label style={field}>Customer email<input {...bind("email")} type="email" style={input} /></label>
        <label style={field}>Customer phone<input {...bind("phone")} style={input} /></label>
        <label style={field}>Recipient name<input {...bind("recipientName")} required style={input} /></label>
        <label style={field}>Recipient phone<input {...bind("recipientPhone")} style={input} /></label>
        <label style={field}>Address line 1<input {...bind("address1")} required style={input} /></label>
        <label style={field}>Address line 2<input {...bind("address2")} style={input} /></label>
        <label style={field}>City<input {...bind("city")} required style={input} /></label>
        <label style={field}>Province<input {...bind("province")} style={input} /></label>
        <label style={field}>Delivery date<input {...bind("deliveryDate")} type="date" required style={input} /></label>
        <label style={field}>Time slot / Specific time
          <input {...bind("deliveryTime")} list="time-options" required style={input} placeholder="Pumili o mag-type ng oras" />
          <datalist id="time-options">
            {timeSlots.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <label style={field}>Card message<textarea {...bind("cardMessage")} rows={3} style={input} /></label>
        <label style={field}>Delivery fee (PHP)<input {...bind("deliveryFee")} type="number" min={0} step="1" style={input} /></label>
        <label style={field}>GCash reference number<input {...bind("gcashRef")} style={input} /></label>
        <label style={field}>Internal note<textarea {...bind("note")} rows={2} style={input} /></label>
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
