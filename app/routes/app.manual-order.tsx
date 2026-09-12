import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { looksLikeSummary, parseOrderSummary } from "../lib/parse-order-summary";
import { normalizeCustomTimeValue, resolveConfiguredSlotValue } from "../lib/slot-value";
import { getScheduleRules } from "../services/schedule-rules.server";
import { findCodFeeVariant } from "../services/cod-fee.server";

const SOURCES = ["messenger", "instagram"];
const PAYMENTS = ["gcash_pending", "gcash_paid", "cod"] as const;
type Payment = (typeof PAYMENTS)[number];

type VariantOption = { id: string; label: string; price: string };
type UserError = { field: string[] | null; message: string };
type ActionResult = {
  error?: string;
  ok?: true;
  mode?: "draft" | "order";
  payment?: Payment;
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
  mutation CompleteMessengerDraft($id: ID!, $source: String, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, sourceName: $source, paymentPending: $paymentPending) {
      draftOrder { order { id name } }
      userErrors { field message }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
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
  const [rules, codFee] = await Promise.all([getScheduleRules(session.shop), findCodFeeVariant(admin)]);
  return Response.json({
    variants,
    timeSlots: rules.slots.map((slot) => slot.value),
    codFeePrice: codFee.variant ? parseFloat(codFee.variant.price) || 0 : null,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const f = await request.formData();
  const s = (k: string) => (f.get(k) as string | null)?.trim() ?? "";

  const variantId = s("variantId");
  const quantity = Math.max(1, parseInt(s("quantity") || "1", 10));
  const deliveryDate = s("deliveryDate");
  const deliveryTimeInput = s("deliveryTime");
  const source = SOURCES.includes(s("source")) ? s("source") : "messenger";
  const payment: Payment = (PAYMENTS as readonly string[]).includes(s("payment"))
    ? (s("payment") as Payment)
    : "gcash_pending";
  const email = s("email");
  const phone = s("phone");

  if (!variantId || !deliveryDate || !deliveryTimeInput || !s("recipientName") || !s("address1") || !s("city")) {
    return Response.json({ error: "Kulang ang required fields: product, delivery date, time slot, recipient name, address, city." }, { status: 400 });
  }
  // A configured slot is written as configured; anything else must be a time
  // ("8PM", "8PM-9PM") and is written in the same canonical form the
  // reschedule path uses, so the tag and metafield match later moves.
  const rules = await getScheduleRules(session.shop);
  const deliveryTime =
    resolveConfiguredSlotValue(rules, deliveryTimeInput) ?? normalizeCustomTimeValue(deliveryTimeInput);
  if (!deliveryTime) {
    return Response.json({ error: `Hindi mabasa ang oras "${deliveryTimeInput}". Pumili ng slot o mag-type ng oras gaya ng 8PM o 8PM-9PM.` }, { status: 400 });
  }
  if (!email && !phone) {
    return Response.json({ error: "Kailangan ng email o phone para may confirmation at para magamit ang tracking page." }, { status: 400 });
  }

  const [firstName, ...rest] = s("recipientName").split(" ");
  const deliveryFee = parseFloat(s("deliveryFee") || "0");
  const lineItems: Array<{ variantId: string; quantity: number }> = [{ variantId, quantity }];
  if (payment === "cod") {
    const codFee = await findCodFeeVariant(admin);
    if (!codFee.variant) {
      return Response.json({ error: `Walang COD Fee product (SKU COD-FEE) sa store. ${codFee.errors.join("; ")}`.trim() }, { status: 400 });
    }
    lineItems.push({ variantId: codFee.variant.id, quantity: 1 });
  }
  const noteLines = [
    `Source: ${source}`,
    payment === "cod" ? "Payment: Cash on Delivery" : null,
    s("customerName") ? `Ordered by: ${s("customerName")}` : null,
    s("gcashRef") ? `GCash ref: ${s("gcashRef")}` : null,
    s("note") ? `Notes: ${s("note")}` : null,
  ].filter(Boolean);

  const input = {
    lineItems,
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

  if (payment === "gcash_pending") {
    return Response.json({
      ok: true,
      mode: "draft",
      payment,
      draftName: draft.name,
      total: draft.totalPriceSet.shopMoney.amount,
      invoiceUrl: draft.invoiceUrl,
    });
  }

  const completeRes = await admin.graphql(DRAFT_COMPLETE, {
    variables: { id: draft.id, source, paymentPending: payment === "cod" },
  });
  const complete = (await completeRes.json()).data.draftOrderComplete;
  if (complete.userErrors.length) {
    return Response.json({ error: complete.userErrors.map((e: UserError) => e.message).join("; ") }, { status: 400 });
  }
  return Response.json({
    ok: true,
    mode: "order",
    payment,
    orderName: complete.draftOrder.order.name,
    orderId: complete.draftOrder.order.id,
    total: draft.totalPriceSet.shopMoney.amount,
  });
}

const EMPTY_FORM: Record<string, string> = { source: "messenger", quantity: "1", deliveryFee: "0", payment: "gcash_pending" };

const PAYMENT_LABELS: Record<Payment, string> = {
  gcash_pending: "GCash - hinihintay pa ang bayad (draft + invoice link)",
  gcash_paid: "GCash - bayad na at na-verify (paid order agad)",
  cod: "Cash on Delivery - order agad, may COD fee, babayaran sa rider",
};

export default function ManualOrder() {
  const { variants, timeSlots, codFeePrice } = useLoaderData() as {
    variants: VariantOption[];
    timeSlots: string[];
    codFeePrice: number | null;
  };
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

  const selectedVariant = variants.find((v) => v.id === values.variantId) ?? null;
  const qty = Math.max(1, parseInt(values.quantity || "1", 10) || 1);
  const fee = parseFloat(values.deliveryFee || "0") || 0;
  const isCod = values.payment === "cod";
  const codFee = isCod ? (codFeePrice ?? 0) : 0;
  const unitPrice = selectedVariant ? parseFloat(selectedVariant.price) : null;
  const computedTotal = unitPrice === null ? null : unitPrice * qty + fee + codFee;

  const totalMismatch =
    pastedTotal !== null && computedTotal !== null && Math.abs(pastedTotal - computedTotal) > 0.005;
  const difference = totalMismatch && pastedTotal !== null && computedTotal !== null ? pastedTotal - computedTotal : 0;

  // Values that would make product × qty + fee equal the pasted total, offered as hints.
  const matchHints = useMemo(() => {
    if (!totalMismatch || pastedTotal === null || unitPrice === null) return [];
    const hints: string[] = [];
    const feeThatMatches = pastedTotal - unitPrice * qty - codFee;
    if (feeThatMatches >= 0) hints.push(`delivery fee na PHP ${feeThatMatches.toFixed(2)} (sa halip na PHP ${fee.toFixed(2)})`);
    const qtyThatMatches = (pastedTotal - fee - codFee) / unitPrice;
    if (Number.isInteger(qtyThatMatches) && qtyThatMatches >= 1 && qtyThatMatches !== qty) hints.push(`quantity na ${qtyThatMatches} (sa halip na ${qty})`);
    const variantsThatMatch = variants.filter(
      (v) => v.id !== values.variantId && Math.abs(parseFloat(v.price) * qty + fee + codFee - pastedTotal) < 0.005,
    );
    for (const v of variantsThatMatch.slice(0, 3)) hints.push(`product na "${v.label}" (PHP ${v.price})`);
    return hints;
  }, [totalMismatch, pastedTotal, unitPrice, qty, fee, codFee, variants, values.variantId]);

  const field = { display: "grid", gap: 4, marginBottom: 12 } as const;
  const input = { padding: 8, border: "1px solid #c9cccf", borderRadius: 6, font: "inherit" } as const;
  const peso = (n: number) => `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
  const flag = totalMismatch ? <span style={{ color: "#d72c0d", fontWeight: 700 }} title="Kasama sa total na hindi tugma"> *</span> : null;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 24, font: "14px system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Manual order</h1>

      {result?.error && (
        <div style={{ background: "#fed3d1", padding: 12, borderRadius: 8, marginBottom: 16 }}>{result.error}</div>
      )}
      {result?.ok && result.mode === "order" && (
        <div style={{ background: "#cdfed3", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <strong>
            Order {result.orderName} created{result.payment === "cod" ? " - Cash on Delivery, payment pending" : " and marked as paid"}. Total PHP {result.total}.
          </strong>
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
      {pastedTotal !== null && computedTotal !== null && unitPrice !== null && (
        <div style={{ background: totalMismatch ? "#ffea8a" : "#cdfed3", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "2px 16px", justifyContent: "start" }}>
            <span>Product{flag}</span><span>{peso(unitPrice)} × {qty}{flag} = {peso(unitPrice * qty)}</span>
            <span>Delivery fee{flag}</span><span>{peso(fee)}</span>
            {isCod && (<><span>COD fee{flag}</span><span>{peso(codFee)}</span></>)}
            <span>Computed total</span><strong>{peso(computedTotal)}</strong>
            <span>Total sa summary</span><strong>{peso(pastedTotal)}</strong>
            {totalMismatch && (
              <>
                <span style={{ color: "#d72c0d", fontWeight: 700 }}>Diperensya</span>
                <strong style={{ color: "#d72c0d" }}>{difference > 0 ? "+" : "−"}{peso(Math.abs(difference))}</strong>
              </>
            )}
          </div>
          {totalMismatch ? (
            <div style={{ marginTop: 8 }}>
              Hindi tugma ang total. Ang mga may <span style={{ color: "#d72c0d", fontWeight: 700 }}>*</span> ang pwedeng mali.
              {matchHints.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  Magtutugma kung: {matchHints.join("; o ")}.
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>Tugma ang total sa summary.</div>
          )}
        </div>
      )}

      <Form method="post" onPaste={onFieldPaste}>
        <label style={field}>Source
          <select {...bind("source")} style={input}>{SOURCES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </label>
        <label style={field}><span>Product{flag}</span>
          <select {...bind("variantId")} required style={input}>
            <option value="">Pumili ng bouquet</option>
            {variants.map((v) => <option key={v.id} value={v.id}>{v.label} (PHP {v.price})</option>)}
          </select>
        </label>
        <label style={field}><span>Quantity{flag}</span><input {...bind("quantity")} type="number" min={1} style={input} /></label>
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
          <input {...bind("deliveryTime")} list="time-options" required style={input} placeholder="Pumili ng slot o mag-type ng oras (8PM, 8PM-9PM)" />
          <datalist id="time-options">
            {timeSlots.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <label style={field}>Card message<textarea {...bind("cardMessage")} rows={3} style={input} /></label>
        <label style={field}><span>Delivery fee (PHP){flag}</span><input {...bind("deliveryFee")} type="number" min={0} step="1" style={input} /></label>
        <label style={field}>GCash reference number<input {...bind("gcashRef")} style={input} /></label>
        <label style={field}>Internal note<textarea {...bind("note")} rows={2} style={input} /></label>
        <label style={field}>Payment
          <select {...bind("payment")} style={input}>
            {PAYMENTS.map((p) => <option key={p} value={p}>{PAYMENT_LABELS[p]}</option>)}
          </select>
          {isCod && codFeePrice === null && (
            <span style={{ color: "#d72c0d" }}>Walang COD Fee product (SKU COD-FEE) sa store - hindi makakagawa ng COD order.</span>
          )}
          {isCod && codFeePrice !== null && (
            <span style={{ color: "#6d7175" }}>Idadagdag ang COD Fee line item (PHP {codFeePrice}) at gagawing order agad na may payment pending.</span>
          )}
        </label>
        <button type="submit" disabled={busy} style={{ ...input, background: "#303030", color: "#fff", cursor: "pointer" }}>
          {busy ? "Saving..." : "Create order"}
        </button>
      </Form>
    </div>
  );
}
