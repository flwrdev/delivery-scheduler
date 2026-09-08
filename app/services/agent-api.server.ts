// Backend for the Meta Business Agent tools (/api/agent/*): draft-order
// creation, order status lookup, and delivery quotes. Every Shopify write goes
// through the offline admin session of the shop named by SHOP_DOMAIN.

import {
  DEFAULT_DELIVERY_SCHEDULE_RULES,
  getAvailableSlots,
  getShopLocalDate,
  validateDeliveryDate,
  validateDeliverySelection,
  type DeliveryScheduleRules,
} from "../lib/delivery-availability";
import { MESSENGER_PSID_ATTRIBUTE, MESSENGER_SOURCE_TAG } from "../lib/messenger-conversation";
import { lookupOrder, normalizeOrderNumber, type TrackingResult } from "../lib/order-tracking.server";
import { resolveShopDomain } from "../lib/shop-domain.server";
import { unauthenticated } from "../shopify.server";
import { COD_FEE_SKU, findCodFeeVariant } from "./cod-fee.server";
import { checkDeliveryCoverage } from "./delivery-coverage.server";
import { getScheduleRulesWithBookedCounts } from "./schedule-rules.server";

type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
type AdminClient = { graphql: AdminGraphql };

export class AgentApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{4,80}$/;
const AGENT_KEY_TAG_PREFIX = "agent-key-";
const MAX_ITEMS = 10;
const MAX_TEXT = 500;
const FREE_SHIPPING_ABOVE_PHP = 2500;

const COD_FALLBACK = { feeAmount: 70, minimumAmount: 0, maximumAmount: 2500 as number | null };

// Metro Manila LGUs after normalizeCity(): lowercase, no diacritics, no " city" suffix.
const DEFAULT_COD_CITIES = [
  "manila", "quezon", "makati", "pasay", "caloocan", "malabon", "navotas", "valenzuela",
  "san juan", "mandaluyong", "pasig", "pateros", "taguig", "paranaque", "las pinas",
  "muntinlupa", "marikina",
];
const DEFAULT_COD_ZIP_RANGES: Array<[number, number]> = [
  [1000, 1018], [1100, 1138], [1200, 1235], [1300, 1309], [1400, 1413], [1420, 1428],
  [1440, 1448], [1470, 1490], [1500, 1504], [1550, 1556], [1600, 1612], [1620, 1639],
  [1700, 1714], [1740, 1752], [1770, 1781], [1800, 1820],
];

export function statusPageUrlFor(orderNumber: string): string {
  const base = process.env.STATUS_PAGE_BASE_URL?.trim() || "https://flowercart.store/pages/track";
  return `${base}?order=${encodeURIComponent(orderNumber)}`;
}

export function customerAccountUrl(): string {
  return process.env.CUSTOMER_ACCOUNT_URL?.trim() || "https://flowercart.store/account";
}

export async function getAgentAdmin(): Promise<{ admin: AdminClient; shop: string }> {
  const shop = resolveShopDomain();
  if (!shop) {
    throw new AgentApiError(503, "not_configured", "SHOP_DOMAIN is not configured on this environment.");
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { admin: admin as unknown as AdminClient, shop };
  } catch (error) {
    throw new AgentApiError(
      503,
      "no_session",
      `No offline admin session for ${shop}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── Input parsing ────────────────────────────────────────────────────────────

export interface DraftItemInput {
  variantId?: string;
  productHandle?: string;
  productTitle?: string;
  variantTitle?: string;
  quantity: number;
}

export interface CreateDraftInput {
  idempotencyKey: string;
  customer: { email: string; firstName?: string; lastName?: string; phone?: string };
  recipient: {
    name: string;
    phone?: string;
    address1: string;
    address2?: string;
    city: string;
    province?: string;
    zip?: string;
  };
  items: DraftItemInput[];
  delivery: { date: string; timeSlot: string; cardMessage?: string; instructions?: string };
  deliveryFee: number;
  paymentMode: "invoice" | "cod";
  source: string;
  channel?: { psid?: string };
}

function str(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalStr(value: unknown, max = MAX_TEXT): string | undefined {
  const s = str(value, max);
  return s.length > 0 ? s : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCreateDraftInput(body: unknown): CreateDraftInput {
  const fields: string[] = [];
  const root = isRecord(body) ? body : {};

  const idempotencyKey = str(root.idempotencyKey, 80);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) fields.push("idempotencyKey");

  const customerRaw = isRecord(root.customer) ? root.customer : {};
  const email = str(customerRaw.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.push("customer.email");

  const recipientRaw = isRecord(root.recipient) ? root.recipient : {};
  const recipient = {
    name: str(recipientRaw.name, 120),
    phone: optionalStr(recipientRaw.phone, 40),
    address1: str(recipientRaw.address1, 255),
    address2: optionalStr(recipientRaw.address2, 255),
    city: str(recipientRaw.city, 80),
    province: optionalStr(recipientRaw.province, 80),
    zip: optionalStr(recipientRaw.zip, 10),
  };
  if (!recipient.name) fields.push("recipient.name");
  if (!recipient.address1) fields.push("recipient.address1");
  if (!recipient.city) fields.push("recipient.city");

  const itemsRaw = Array.isArray(root.items) ? root.items.slice(0, MAX_ITEMS) : [];
  const items: DraftItemInput[] = [];
  itemsRaw.forEach((raw, index) => {
    const item = isRecord(raw) ? raw : {};
    const quantity = Math.floor(Number(item.quantity ?? 1));
    const parsed: DraftItemInput = {
      variantId: optionalStr(item.variantId, 120),
      productHandle: optionalStr(item.productHandle, 255),
      productTitle: optionalStr(item.productTitle, 255),
      variantTitle: optionalStr(item.variantTitle, 255),
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 50) : 0,
    };
    if (!parsed.variantId && !parsed.productHandle && !parsed.productTitle) fields.push(`items[${index}].product`);
    if (parsed.quantity === 0) fields.push(`items[${index}].quantity`);
    items.push(parsed);
  });
  if (items.length === 0) fields.push("items");

  const deliveryRaw = isRecord(root.delivery) ? root.delivery : {};
  const delivery = {
    date: str(deliveryRaw.date, 10),
    timeSlot: str(deliveryRaw.timeSlot, 40),
    cardMessage: optionalStr(deliveryRaw.cardMessage, 300),
    instructions: optionalStr(deliveryRaw.instructions, 500),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(delivery.date)) fields.push("delivery.date");
  if (!delivery.timeSlot) fields.push("delivery.timeSlot");

  const deliveryFee = Number(root.deliveryFee ?? 0);
  if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 5000) fields.push("deliveryFee");

  const paymentModeRaw = str(root.paymentMode, 20).toLowerCase() || "invoice";
  if (paymentModeRaw !== "invoice" && paymentModeRaw !== "cod") fields.push("paymentMode");

  const channelRaw = isRecord(root.channel) ? root.channel : {};
  const psid = optionalStr(channelRaw.psid, 40);
  if (psid && !/^\d{5,32}$/.test(psid)) fields.push("channel.psid");

  if (fields.length > 0) {
    throw new AgentApiError(422, "validation", "Kulang o mali ang ilang fields.", { fields });
  }

  return {
    idempotencyKey,
    customer: {
      email,
      firstName: optionalStr(customerRaw.firstName, 80),
      lastName: optionalStr(customerRaw.lastName, 80),
      phone: optionalStr(customerRaw.phone, 40),
    },
    recipient,
    items,
    delivery,
    deliveryFee: Math.round(deliveryFee),
    paymentMode: paymentModeRaw as "invoice" | "cod",
    source: "messenger",
    channel: psid ? { psid } : undefined,
  };
}

// ─── Shopify queries ──────────────────────────────────────────────────────────

const DRAFT_BY_TAG_QUERY = `#graphql
  query AgentDraftByTag($q: String!) {
    draftOrders(first: 1, query: $q) {
      nodes {
        id
        name
        status
        invoiceUrl
        totalPriceSet { shopMoney { amount } }
        order { id name }
      }
    }
  }
`;

const VARIANT_BY_ID_QUERY = `#graphql
  query AgentVariantById($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      availableForSale
      product { id title handle status }
    }
  }
`;

const PRODUCT_SEARCH_QUERY = `#graphql
  query AgentProductSearch($q: String!) {
    products(first: 5, query: $q) {
      nodes {
        id
        title
        handle
        status
        variants(first: 20) { nodes { id title price availableForSale } }
      }
    }
  }
`;

const DRAFT_CREATE_MUTATION = `#graphql
  mutation AgentDraftCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name status invoiceUrl totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;

const DRAFT_COMPLETE_MUTATION = `#graphql
  mutation AgentDraftComplete($id: ID!, $paymentPending: Boolean, $source: String) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending, sourceName: $source) {
      draftOrder { id name order { id name } }
      userErrors { field message }
    }
  }
`;

const COD_CONFIG_QUERY = `#graphql
  query AgentCodConfig {
    paymentCustomizations(first: 25) {
      nodes {
        title
        metafield(namespace: "$app:cod-eligibility", key: "function-configuration") { jsonValue }
      }
    }
  }
`;

type DraftNode = {
  id: string;
  name: string;
  status: string;
  invoiceUrl: string | null;
  totalPriceSet: { shopMoney: { amount: string } } | null;
  order: { id: string; name: string } | null;
};

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new AgentApiError(502, "shopify_error", json.errors.map((e) => e.message).join("; "));
  }
  return (json.data ?? {}) as T;
}

export async function findDraftByIdempotencyKey(admin: AdminClient, key: string): Promise<DraftNode | null> {
  const data = await gql<{ draftOrders?: { nodes?: DraftNode[] } }>(admin, DRAFT_BY_TAG_QUERY, {
    q: `tag:${AGENT_KEY_TAG_PREFIX}${key}`,
  });
  return data.draftOrders?.nodes?.[0] ?? null;
}

export interface ResolvedVariant {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  title: string;
  price: number;
  quantity: number;
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function resolveVariant(admin: AdminClient, item: DraftItemInput): Promise<ResolvedVariant> {
  const label = item.variantId ?? item.productHandle ?? item.productTitle ?? "item";

  if (item.variantId) {
    const data = await gql<{
      productVariant: {
        id: string;
        title: string;
        price: string;
        availableForSale: boolean;
        product: { title: string; status: string };
      } | null;
    }>(admin, VARIANT_BY_ID_QUERY, { id: item.variantId });
    const v = data.productVariant;
    if (!v || v.product.status !== "ACTIVE") {
      throw new AgentApiError(422, "product_not_found", `Hindi available ang product na ${label}.`, { fields: ["items"] });
    }
    return toResolved(v.product.title, v.title, v.id, v.price, item.quantity);
  }

  const q = item.productHandle ? `handle:${item.productHandle}` : `title:*${(item.productTitle ?? "").replace(/["*]/g, "")}*`;
  const data = await gql<{
    products?: {
      nodes?: Array<{
        id: string;
        title: string;
        handle: string;
        status: string;
        variants: { nodes: Array<{ id: string; title: string; price: string; availableForSale: boolean }> };
      }>;
    };
  }>(admin, PRODUCT_SEARCH_QUERY, { q });

  const wantedTitle = normalizeText(item.productTitle ?? "");
  const products = (data.products?.nodes ?? []).filter((p) => p.status === "ACTIVE");
  const product =
    products.find((p) => item.productHandle && p.handle === item.productHandle) ??
    products.find((p) => wantedTitle && normalizeText(p.title) === wantedTitle) ??
    products[0];
  if (!product || product.variants.nodes.length === 0) {
    throw new AgentApiError(422, "product_not_found", `Hindi ko mahanap ang product na "${label}".`, { fields: ["items"] });
  }

  const wantedVariant = normalizeText(item.variantTitle ?? "");
  const variant =
    (wantedVariant && product.variants.nodes.find((v) => normalizeText(v.title) === wantedVariant)) ||
    product.variants.nodes.find((v) => v.availableForSale) ||
    product.variants.nodes[0];
  return toResolved(product.title, variant.title, variant.id, variant.price, item.quantity);
}

function toResolved(productTitle: string, variantTitle: string, id: string, price: string, quantity: number): ResolvedVariant {
  const title = variantTitle === "Default Title" ? productTitle : `${productTitle} / ${variantTitle}`;
  return { variantId: id, productTitle, variantTitle, title, price: Number(price) || 0, quantity };
}

// ─── COD ──────────────────────────────────────────────────────────────────────

export interface CodConfig {
  feeAmount: number;
  minimumAmount: number;
  maximumAmount: number | null;
  allowedCities: string[];
  allowedZipRanges: Array<[number, number]>;
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function loadCodConfig(admin: AdminClient): Promise<CodConfig> {
  const fallback: CodConfig = {
    ...COD_FALLBACK,
    allowedCities: DEFAULT_COD_CITIES,
    allowedZipRanges: DEFAULT_COD_ZIP_RANGES,
  };
  try {
    const data = await gql<{
      paymentCustomizations?: { nodes?: Array<{ title: string; metafield?: { jsonValue?: Record<string, unknown> } | null }> };
    }>(admin, COD_CONFIG_QUERY);
    const nodes = data.paymentCustomizations?.nodes ?? [];
    const config =
      (nodes.find((n) => n.metafield?.jsonValue) ?? nodes.find((n) => /cod|cash on delivery/i.test(n.title)))?.metafield
        ?.jsonValue ?? null;
    if (!config) return fallback;
    const cities = Array.isArray(config.allowedCities)
      ? config.allowedCities.filter((c): c is string => typeof c === "string").map(normalizeCity)
      : fallback.allowedCities;
    const ranges = Array.isArray(config.allowedZipRanges)
      ? config.allowedZipRanges.filter(
          (r): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((n) => Number.isFinite(Number(n))),
        )
      : fallback.allowedZipRanges;
    return {
      feeAmount: positiveNumber(config.feeAmount) ?? fallback.feeAmount,
      minimumAmount: positiveNumber(config.minimumAmount) ?? 0,
      maximumAmount: "maximumAmount" in config ? positiveNumber(config.maximumAmount) : fallback.maximumAmount,
      allowedCities: cities.length ? cities : fallback.allowedCities,
      allowedZipRanges: ranges.length ? ranges : fallback.allowedZipRanges,
    };
  } catch (error) {
    console.warn(`[agent-api] COD config fallback: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export function normalizeCity(value: string): string {
  return normalizeText(value).replace(/\s+city$/, "").trim();
}

export function isCodAreaEligible(config: CodConfig, city: string, zip?: string): boolean {
  const zipNumber = Number((zip ?? "").replace(/\D/g, ""));
  if (zipNumber && config.allowedZipRanges.some(([lo, hi]) => zipNumber >= lo && zipNumber <= hi)) return true;
  const cityNorm = normalizeCity(city);
  return config.allowedCities.some((allowed) => cityNorm === allowed || cityNorm.includes(allowed));
}

export function codAmountIssue(config: CodConfig, subtotal: number): string | null {
  if (subtotal < config.minimumAmount) return `COD ay para sa orders na ₱${config.minimumAmount} pataas.`;
  if (config.maximumAmount !== null && subtotal > config.maximumAmount) {
    return `COD ay hanggang ₱${config.maximumAmount} lang. Invoice na lang po para dito.`;
  }
  return null;
}

// ─── Draft creation ───────────────────────────────────────────────────────────

export interface CreateDraftResult {
  ok: true;
  reused: boolean;
  mode: "draft" | "order";
  draftId: string;
  draftName: string;
  orderId?: string;
  orderName?: string;
  invoiceUrl?: string;
  total: number;
  summary?: {
    items: Array<{ title: string; quantity: number; price: number }>;
    deliveryFee: number;
    codFee?: number;
    total: number;
  };
  delivery: { date: string; timeSlot: string };
  statusPageUrl?: string;
  nextStep: string;
}

function splitName(name: string): { firstName: string; lastName?: string } {
  const [firstName, ...rest] = name.split(/\s+/);
  return { firstName, lastName: rest.join(" ") || undefined };
}

async function loadRules(shop: string, admin: AdminClient): Promise<DeliveryScheduleRules> {
  try {
    return await getScheduleRulesWithBookedCounts(shop, admin as never);
  } catch (error) {
    console.warn(`[agent-api] schedule rules fallback: ${error instanceof Error ? error.message : String(error)}`);
    return DEFAULT_DELIVERY_SCHEDULE_RULES;
  }
}

function reusedResult(draft: DraftNode, input: CreateDraftInput): CreateDraftResult {
  const total = Number(draft.totalPriceSet?.shopMoney.amount ?? 0);
  if (draft.order) {
    const orderNumber = draft.order.name.replace("#", "");
    return {
      ok: true,
      reused: true,
      mode: "order",
      draftId: draft.id,
      draftName: draft.name,
      orderId: draft.order.id,
      orderName: draft.order.name,
      total,
      delivery: { date: input.delivery.date, timeSlot: input.delivery.timeSlot },
      statusPageUrl: statusPageUrlFor(orderNumber),
      nextStep: `Confirmed na ang order ${draft.order.name}. May confirmation email na rin ang customer.`,
    };
  }
  return {
    ok: true,
    reused: true,
    mode: "draft",
    draftId: draft.id,
    draftName: draft.name,
    invoiceUrl: draft.invoiceUrl ?? undefined,
    total,
    delivery: { date: input.delivery.date, timeSlot: input.delivery.timeSlot },
    nextStep: "May existing draft na para sa order na ito. Ipadala ulit ang invoice link.",
  };
}

export async function createAgentDraftOrder(input: CreateDraftInput): Promise<CreateDraftResult> {
  const { admin, shop } = await getAgentAdmin();

  const existing = await findDraftByIdempotencyKey(admin, input.idempotencyKey);
  if (existing) return reusedResult(existing, input);

  const rules = await loadRules(shop, admin);
  const validation = validateDeliverySelection(rules, input.delivery.date, input.delivery.timeSlot);
  if (!validation.ok) {
    const status = validation.code === "slot_unavailable" || validation.code === "no_slots_available" ? 409 : 422;
    throw new AgentApiError(status, validation.code, validation.message, {
      availableSlots: validation.availableSlots.map((s) => s.value),
      minDate: validation.minDate,
      maxDate: validation.maxDate,
    });
  }

  const resolved: ResolvedVariant[] = [];
  for (const item of input.items) {
    resolved.push(await resolveVariant(admin, item));
  }
  const subtotal = resolved.reduce((sum, r) => sum + r.price * r.quantity, 0);
  const lineItems = resolved.map((r) => ({ variantId: r.variantId, quantity: r.quantity }));

  let codFee: number | undefined;
  if (input.paymentMode === "cod") {
    const cod = await loadCodConfig(admin);
    if (!isCodAreaEligible(cod, input.recipient.city, input.recipient.zip)) {
      throw new AgentApiError(422, "cod_not_available", "COD ay para sa Metro Manila addresses lang. Invoice na lang po.", {
        fields: ["paymentMode"],
      });
    }
    const amountIssue = codAmountIssue(cod, subtotal);
    if (amountIssue) throw new AgentApiError(422, "cod_not_available", amountIssue, { fields: ["paymentMode"] });
    const { variant, errors } = await findCodFeeVariant(admin as never);
    if (!variant) {
      throw new AgentApiError(502, "cod_fee_unavailable", `Hindi mahanap ang ${COD_FEE_SKU} variant.${errors.length ? ` ${errors[0]}` : ""}`);
    }
    codFee = Number(variant.price) || cod.feeAmount;
    lineItems.push({ variantId: variant.id, quantity: 1 });
  }

  const { firstName, lastName } = splitName(input.recipient.name);
  const customAttributes = [
    { key: "Delivery Date", value: input.delivery.date },
    { key: "Delivery Time", value: input.delivery.timeSlot },
    { key: "Card Message", value: input.delivery.cardMessage ?? "" },
    { key: "Instruction", value: input.delivery.instructions ?? "" },
    { key: "Agent Idempotency Key", value: input.idempotencyKey },
    ...(input.channel?.psid ? [{ key: MESSENGER_PSID_ATTRIBUTE, value: input.channel.psid }] : []),
  ];
  const tags = [
    input.delivery.date,
    input.delivery.timeSlot,
    MESSENGER_SOURCE_TAG,
    `${AGENT_KEY_TAG_PREFIX}${input.idempotencyKey}`,
    ...(input.paymentMode === "cod" ? ["cod"] : []),
  ];
  const noteLines = [
    `Source: ${input.source} (agent)`,
    input.customer.firstName || input.customer.lastName
      ? `Ordered by: ${[input.customer.firstName, input.customer.lastName].filter(Boolean).join(" ")}`
      : null,
    input.delivery.instructions ? `Instructions: ${input.delivery.instructions}` : null,
  ].filter(Boolean);

  const draftInput = {
    lineItems,
    email: input.customer.email,
    phone: input.customer.phone,
    shippingAddress: {
      firstName,
      lastName,
      address1: input.recipient.address1,
      address2: input.recipient.address2,
      city: input.recipient.city,
      provinceCode: undefined,
      province: input.recipient.province,
      zip: input.recipient.zip,
      phone: input.recipient.phone ?? input.customer.phone,
      countryCode: "PH",
    },
    customAttributes,
    tags,
    shippingLine: {
      title: "LALAMOVE",
      priceWithCurrency: { amount: input.deliveryFee, currencyCode: "PHP" },
    },
    note: noteLines.join("\n"),
    sourceName: input.source,
  };

  const created = await gql<{
    draftOrderCreate: { draftOrder: DraftNode | null; userErrors: Array<{ field: string[] | null; message: string }> };
  }>(admin, DRAFT_CREATE_MUTATION, { input: draftInput });
  const create = created.draftOrderCreate;
  if (create.userErrors.length || !create.draftOrder) {
    throw new AgentApiError(502, "draft_create_failed", create.userErrors.map((e) => e.message).join("; ") || "Draft order create failed.");
  }
  const draft = create.draftOrder;
  const total = Number(draft.totalPriceSet?.shopMoney.amount ?? subtotal + input.deliveryFee + (codFee ?? 0));
  const summary = {
    items: resolved.map((r) => ({ title: r.title, quantity: r.quantity, price: r.price })),
    deliveryFee: input.deliveryFee,
    ...(codFee !== undefined ? { codFee } : {}),
    total,
  };

  if (input.paymentMode === "cod") {
    const completed = await gql<{
      draftOrderComplete: { draftOrder: { order: { id: string; name: string } | null } | null; userErrors: Array<{ message: string }> };
    }>(admin, DRAFT_COMPLETE_MUTATION, { id: draft.id, paymentPending: true, source: input.source });
    const complete = completed.draftOrderComplete;
    const order = complete.draftOrder?.order;
    if (complete.userErrors.length || !order) {
      throw new AgentApiError(502, "draft_complete_failed", complete.userErrors.map((e) => e.message).join("; ") || "Draft order complete failed.", {
        draftId: draft.id,
        draftName: draft.name,
      });
    }
    const orderNumber = order.name.replace("#", "");
    return {
      ok: true,
      reused: false,
      mode: "order",
      draftId: draft.id,
      draftName: draft.name,
      orderId: order.id,
      orderName: order.name,
      total,
      summary,
      delivery: { date: input.delivery.date, timeSlot: input.delivery.timeSlot },
      statusPageUrl: statusPageUrlFor(orderNumber),
      nextStep: `Confirmed na ang COD order ${order.name}: ₱${total} cash sa rider sa ${input.delivery.date}, ${input.delivery.timeSlot}. May confirmation email na rin.`,
    };
  }

  return {
    ok: true,
    reused: false,
    mode: "draft",
    draftId: draft.id,
    draftName: draft.name,
    invoiceUrl: draft.invoiceUrl ?? undefined,
    total,
    summary,
    delivery: { date: input.delivery.date, timeSlot: input.delivery.timeSlot },
    nextStep: "Ipadala ang invoiceUrl. Pag nagbayad, darating ang confirmation email na may order number.",
  };
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface OrderStatusResult {
  ok: true;
  orderName: string;
  stage: Extract<TrackingResult, { found: true }>["stage"];
  headline: string;
  detail: string;
  delivery: { date: string | null; timeSlot: string | null };
  items: string[];
  trackingUrl: string | null;
  statusPageUrl: string;
  canReschedule: boolean;
  reschedulePageUrl: string;
  message: string;
}

export async function getAgentOrderStatus(orderRaw: string, emailRaw: string): Promise<OrderStatusResult> {
  const orderNumber = normalizeOrderNumber(orderRaw);
  const email = emailRaw.trim().toLowerCase();
  if (!orderNumber) throw new AgentApiError(422, "validation", "Kailangan ng order number (hal. 4220).", { fields: ["order"] });
  if (!email.includes("@")) throw new AgentApiError(422, "validation", "Kailangan ng email na ginamit sa checkout.", { fields: ["email"] });

  const { admin } = await getAgentAdmin();
  const today = getShopLocalDate();
  const result = await lookupOrder((q, opts) => admin.graphql(q, opts), orderNumber, email, today);
  if (!result.found) {
    throw new AgentApiError(404, "order_not_found", "Walang order na tumutugma sa order number at email na iyan.");
  }

  const canReschedule = result.stage === "confirmed" || result.stage === "preparing";
  const when = [result.deliveryDate, result.deliveryTime].filter(Boolean).join(", ");
  const stageText: Record<OrderStatusResult["stage"], string> = {
    waiting_payment: "Hinihintay pa ang bayad",
    confirmed: "Confirmed at naka-schedule",
    preparing: "Inihahanda ngayong araw",
    on_the_way: "Otw na ang rider",
    own_rider: "Otw na kasama ang sariling rider namin",
    delivered: "Delivered na",
    cancelled: "Cancelled",
  };
  return {
    ok: true,
    orderName: result.orderName,
    stage: result.stage,
    headline: result.headline,
    detail: result.detail,
    delivery: { date: result.deliveryDate, timeSlot: result.deliveryTime },
    items: result.items,
    trackingUrl: result.trackingUrl,
    statusPageUrl: statusPageUrlFor(orderNumber),
    canReschedule,
    reschedulePageUrl: customerAccountUrl(),
    message: `Order ${result.orderName}: ${stageText[result.stage]}${when ? ` para sa ${when}` : ""}.`,
  };
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export interface DeliveryQuoteResult {
  ok: true;
  covered: boolean;
  note?: string;
  areas: Array<{ label: string; feePhp: number | null; estimate: boolean; provincial: boolean }>;
  feeMin: number | null;
  feeMax: number | null;
  freeShippingAbovePhp: number;
  provincialNote?: string;
  cod: { availableInArea: boolean; feeAmount: number; minimumAmount: number; maximumAmount: number | null };
  date?: { value: string; valid: boolean; message: string; minDate: string; maxDate: string; availableSlots: string[] };
  slots: string[];
}

export async function getAgentDeliveryQuote(params: { city?: string; zip?: string; date?: string }): Promise<DeliveryQuoteResult> {
  const city = (params.city ?? "").trim().slice(0, 60);
  const zip = (params.zip ?? "").replace(/\D/g, "").slice(0, 4);
  const date = (params.date ?? "").trim().slice(0, 10);
  if (!city && !zip) throw new AgentApiError(422, "validation", "Kailangan ng city o ZIP code.", { fields: ["city"] });

  const { admin, shop } = await getAgentAdmin();
  const coverage = checkDeliveryCoverage({ zip: zip || undefined, area: city || undefined });
  const cod = await loadCodConfig(admin);
  const rules = await loadRules(shop, admin);

  const base: Omit<DeliveryQuoteResult, "covered" | "areas" | "feeMin" | "feeMax"> = {
    ok: true,
    freeShippingAbovePhp: FREE_SHIPPING_ABOVE_PHP,
    cod: {
      availableInArea: isCodAreaEligible(cod, city, zip),
      feeAmount: cod.feeAmount,
      minimumAmount: cod.minimumAmount,
      maximumAmount: cod.maximumAmount,
    },
    slots: rules.slots.map((s) => s.value),
  };

  if (date) {
    const check = validateDeliveryDate(rules, date);
    base.date = {
      value: date,
      valid: check.ok,
      message: check.ok ? "" : check.message,
      minDate: check.minDate,
      maxDate: check.maxDate,
      availableSlots: (check.ok ? getAvailableSlots(rules, date) : check.availableSlots).map((s) => s.value),
    };
  }

  if (!coverage.ok) throw new AgentApiError(422, "validation", coverage.error, { fields: ["city"] });
  if (!coverage.covered) {
    return { ...base, covered: false, note: coverage.note, areas: [], feeMin: null, feeMax: null };
  }

  const areas = coverage.matches.slice(0, 5).map((m) => ({
    label: m.zip ? `${m.area}, ${m.city} (${m.zip})` : m.city,
    feePhp: m.estimatedFeePhp ?? m.flatFeePhp ?? null,
    estimate: m.estimatedFeePhp != null,
    provincial: Boolean(m.provincial),
  }));
  const fees = areas.map((a) => a.feePhp).filter((f): f is number => f !== null);
  return {
    ...base,
    covered: true,
    areas,
    feeMin: fees.length ? Math.min(...fees) : null,
    feeMax: fees.length ? Math.max(...fees) : null,
    ...(coverage.provincialNote ? { provincialNote: coverage.provincialNote } : {}),
  };
}
