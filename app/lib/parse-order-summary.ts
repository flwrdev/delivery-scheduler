export type ParsedOrderSummary = {
  values: Record<string, string>;
  pastedTotal: number | null;
  productName: string | null;
  warnings: string[];
};

export type ParsedTotalBreakdown = {
  total: number | null;
  productTotal: number | null;
  deliveryFee: number | null;
  codFee: number | null;
};

type VariantLike = { id: string; label: string };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const LINE_RE = /^\s*[-•]?\s*\**\s*([^:*]+?)\s*\**\s*:\s*(.+?)\s*$/;

function clean(value: string): string {
  return value.replace(/\*\*/g, "").trim();
}

function parseMoney(value: string): number | null {
  const n = parseFloat(value.replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}

// "PHP 1,628 (PHP 1,399 bouquet + PHP 159 delivery + PHP 70 COD fee)": the
// amount before the parenthesis is the total; each "+"-separated part inside
// is classified by its label. Parts with no recognized label are ignored.
export function parseTotalBreakdown(value: string): ParsedTotalBreakdown {
  const open = value.indexOf("(");
  const totalPart = open === -1 ? value : value.slice(0, open);
  const out: ParsedTotalBreakdown = { total: parseMoney(totalPart), productTotal: null, deliveryFee: null, codFee: null };
  if (open === -1) return out;
  const inner = value.slice(open + 1, value.lastIndexOf(")") === -1 ? undefined : value.lastIndexOf(")"));
  for (const part of inner.split(/\s*\+\s*/)) {
    const amount = parseMoney(part);
    if (amount === null) continue;
    const label = part.toLowerCase();
    if (/\bcod\b|cash on delivery/.test(label)) out.codFee = amount;
    else if (/deliver|shipping|lalamove/.test(label)) out.deliveryFee = amount;
    else if (/bouquet|product|item|flower/.test(label)) out.productTotal = amount;
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Accepts "Sept 10, 2026, 3:00 PM - 4:00 PM", "September 10 3PM-6PM",
// "2026-09-10 12PM-3PM", "09/10/2026, 9AM-12PM". Whatever follows the date is the time.
export function parseDeliveryDateTime(value: string, now = new Date()): { date: string; time: string } | null {
  const text = clean(value);

  const named = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/);
  const monthKey = named?.[1].toLowerCase().slice(0, 3);
  if (named && monthKey && MONTHS[monthKey]) {
    const month = MONTHS[monthKey];
    const day = parseInt(named[2], 10);
    const year = named[3] ? parseInt(named[3], 10) : now.getFullYear();
    const rest = text.slice(named.index! + named[0].length);
    return { date: `${year}-${pad(month)}-${pad(day)}`, time: stripTimePrefix(rest) };
  }

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const rest = text.slice(iso.index! + iso[0].length);
    return { date: iso[0], time: stripTimePrefix(rest) };
  }

  const slash = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const rest = text.slice(slash.index! + slash[0].length);
    return {
      date: `${slash[3]}-${pad(parseInt(slash[1], 10))}-${pad(parseInt(slash[2], 10))}`,
      time: stripTimePrefix(rest),
    };
  }

  return null;
}

function stripTimePrefix(rest: string): string {
  return rest.replace(/^[\s,|–-]*(?:at\s+)?/i, "").trim();
}

// "27 PNP Compound Hilltop, Brgy. Dolores, Taytay, Rizal" →
// address1 = first part, address2 = middle parts, city = second-to-last, province = last.
export function splitAddress(value: string): Record<string, string> {
  const parts = clean(value).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { address1: parts[0] };
  if (parts.length === 2) return { address1: parts[0], city: parts[1] };
  return {
    address1: parts[0],
    address2: parts.slice(1, -2).join(", "),
    city: parts[parts.length - 2],
    province: parts[parts.length - 1],
  };
}

export function matchVariant(productName: string, variants: VariantLike[]): VariantLike | null {
  const needle = productName.toLowerCase();
  return (
    variants.find((v) => v.label.toLowerCase() === needle) ??
    variants.find((v) => v.label.toLowerCase().startsWith(needle)) ??
    variants.find((v) => v.label.toLowerCase().includes(needle)) ??
    null
  );
}

// Returns true when the text looks like a pasted summary rather than a plain value.
export function looksLikeSummary(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => LINE_RE.test(line)).length > 0;
}

export function parseOrderSummary(text: string, variants: VariantLike[], now = new Date()): ParsedOrderSummary {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  let pastedTotal: number | null = null;
  let productName: string | null = null;

  const lines = text.split(/\r?\n/);
  const greeting = lines.find((l) => l.trim())?.match(/([A-Za-z][\w'.-]*)!/);
  if (greeting) values.customerName = greeting[1];

  const noteParts: string[] = [];

  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/\s+/g, " ");
    const value = clean(m[2]);
    if (!value) continue;

    if (key === "product" || key === "item" || key === "bouquet") {
      productName = value;
      const hit = matchVariant(value, variants);
      if (hit) values.variantId = hit.id;
      else warnings.push(`Walang product na tumugma sa "${value}". Pumili sa dropdown.`);
    } else if (key === "quantity" || key === "qty") {
      values.quantity = String(Math.max(1, parseInt(value, 10) || 1));
    } else if (key === "recipient" || key === "recipient name") {
      values.recipientName = value;
    } else if (key === "recipient contact" || key === "recipient phone") {
      values.recipientPhone = value;
    } else if (key === "contact" || key === "phone" || key === "contact number" || key === "mobile") {
      values.phone = value;
    } else if (key === "email") {
      values.email = value.toLowerCase();
    } else if (key === "customer" || key === "customer name" || key === "ordered by") {
      values.customerName = value;
    } else if (key === "address" || key === "delivery address") {
      Object.assign(values, splitAddress(value));
    } else if (key === "delivery date & time" || key === "delivery date and time" || key === "delivery" || key === "schedule") {
      const parsed = parseDeliveryDateTime(value, now);
      if (parsed) {
        values.deliveryDate = parsed.date;
        if (parsed.time) values.deliveryTime = parsed.time;
      } else {
        warnings.push(`Hindi mabasa ang delivery date sa "${value}".`);
      }
    } else if (key === "delivery date" || key === "date") {
      const parsed = parseDeliveryDateTime(value, now);
      if (parsed) values.deliveryDate = parsed.date;
      else warnings.push(`Hindi mabasa ang delivery date sa "${value}".`);
    } else if (key === "delivery time" || key === "time" || key === "time slot") {
      values.deliveryTime = value;
    } else if (key === "card message" || key === "message") {
      values.cardMessage = /^(none|n\/a|wala|-)$/i.test(value) ? "" : value;
    } else if (key === "payment" || key === "payment method" || key === "mode of payment") {
      noteParts.push(`Payment: ${value}`);
      if (/\bcod\b|cash on delivery/i.test(value)) values.payment = "cod";
      else if (/gcash/i.test(value)) values.payment = "gcash_pending";
    } else if (key === "gcash ref" || key === "gcash reference" || key === "reference" || key === "ref no") {
      values.gcashRef = value;
    } else if (key === "delivery fee" || key === "shipping fee" || key === "fee") {
      const fee = parseMoney(value);
      if (fee !== null) values.deliveryFee = String(fee);
    } else if (key === "total" || key === "grand total" || key === "total amount") {
      const breakdown = parseTotalBreakdown(value);
      pastedTotal = breakdown.total;
      if (breakdown.deliveryFee !== null) values.deliveryFee = String(breakdown.deliveryFee);
      if (breakdown.codFee !== null) values.payment = "cod";
    } else if (key === "note" || key === "notes" || key === "remarks") {
      noteParts.push(value);
    }
  }

  if (noteParts.length) values.note = noteParts.join("\n");

  return { values, pastedTotal, productName, warnings };
}
