// Shopify Function that runs at checkout and decides whether cash on delivery is offered.
// COD is hidden when the subtotal is below the minimum (default 2500) or above an optional
// maximum, when the address is not in the Philippines, or when it is outside Metro Manila
// (ZIP ranges first, then the city name when the ZIP is missing). When COD stays visible, its
// name can be renamed to show the current fee. Settings come from the function's configuration
// metafield; the defaults are in this file.

import type {
  CartPaymentMethodsTransformRunInput,
  CartPaymentMethodsTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartPaymentMethodsTransformRunResult = {
  operations: [],
};

type Configuration = {
  codMethodName?: string;
  minimumAmount?: number;
  /** Optional COD cap — hide COD when the subtotal exceeds this. Null/absent = no cap. */
  maximumAmount?: number;
  /**
   * The COD fee /app/cod-settings last saved. Display only — the amount is
   * actually charged by the orders/create webhook, which reads the COD Fee
   * variant price. Absent = leave the merchant's method name alone.
   */
  feeAmount?: number;
  allowedZipRanges?: [number, number][];
  allowedCities?: string[];
  cityAliases?: Record<string, string>;
};

// An existing fee suffix on the method name: " +₱70", " + P70.00", " +70".
// Rebuilt on every run so the merchant never has to retype the number in
// Settings → Payments after changing it in the app (that name is a static
// string Shopify has no API for — this rename is the only way to keep it in
// step, and it applies to the CHECKOUT list only).
const FEE_SUFFIX = /\s*\+\s*(?:₱|P)?\s*[\d,]+(?:\.\d+)?\s*$/;

// "70" not "70.00" for a whole amount — matches how the merchant wrote it.
function formatFee(fee: number): string {
  return Number.isInteger(fee) ? String(fee) : fee.toFixed(2);
}

export function withFeeSuffix(name: string, fee: number): string {
  return `${name.replace(FEE_SUFFIX, "")} +₱${formatFee(fee)}`;
}

// Metro Manila (NCR) ZIP ranges — source: Metro_Manila_ZIP_Masterlist (17 LGUs).
// Overridable via the $app:cod-eligibility function-configuration metafield.
const DEFAULT_ZIP_RANGES: [number, number][] = [
  [1000, 1018], // Manila
  [1100, 1138], // Quezon City
  [1200, 1235], // Makati
  [1300, 1309], // Pasay
  [1400, 1413], // Caloocan (south)
  [1420, 1428], // Caloocan (north)
  [1440, 1448], // Valenzuela
  [1470, 1490], // Caloocan / Malabon / Navotas
  [1500, 1504], // San Juan
  [1550, 1556], // Mandaluyong
  [1600, 1612], // Pasig
  [1620, 1639], // Pateros / Taguig
  [1700, 1714], // Parañaque
  [1740, 1752], // Las Piñas
  [1770, 1781], // Muntinlupa
  [1800, 1820], // Marikina
];

// Canonical city names AFTER normalizeCity() — the " city" suffix is stripped,
// kaya "Quezon City" -> "quezon".
const DEFAULT_CITIES = [
  "manila",
  "quezon",
  "makati",
  "pasay",
  "caloocan",
  "malabon",
  "navotas",
  "valenzuela",
  "san juan",
  "mandaluyong",
  "pasig",
  "pateros",
  "taguig",
  "paranaque",
  "las pinas",
  "muntinlupa",
  "marikina",
];

const DEFAULT_CITY_ALIASES: Record<string, string> = {
  qc: "quezon",
  "q c": "quezon",
  "quezon city": "quezon",
  bgc: "taguig",
  "fort bonifacio": "taguig",
  "bonifacio global": "taguig",
  kalookan: "caloocan",
  "metro manila": "manila",
};

// Lowercase, strip diacritics (ñ -> n), drop punctuation, collapse spaces,
// strip a trailing " city" / leading "city of " before matching.
export function normalizeCity(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.startsWith("city of ")) s = s.slice("city of ".length);
  if (s.endsWith(" city")) s = s.slice(0, -" city".length);
  return s.trim();
}

function zipInRanges(zip: string, ranges: [number, number][]): boolean | null {
  const cleaned = zip.trim();
  if (!/^\d{4}$/.test(cleaned)) return null; // walang usable ZIP — hindi masasagot
  const n = parseInt(cleaned, 10);
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

export function cartPaymentMethodsTransformRun(
  input: CartPaymentMethodsTransformRunInput,
): CartPaymentMethodsTransformRunResult {
  const configuration: Configuration =
    (input.paymentCustomization?.metafield?.jsonValue as Configuration) ?? {};

  const codMethodName = (
    configuration.codMethodName ?? "cash on delivery"
  ).toLowerCase();
  const minimumAmount = configuration.minimumAmount ?? 2500;
  const zipRanges = configuration.allowedZipRanges ?? DEFAULT_ZIP_RANGES;
  const cities = (configuration.allowedCities ?? DEFAULT_CITIES).map(
    normalizeCity,
  );
  const aliases = configuration.cityAliases ?? DEFAULT_CITY_ALIASES;

  const codMethods = input.paymentMethods.filter((method) =>
    method.name.toLowerCase().includes(codMethodName),
  );
  if (codMethods.length === 0) {
    return NO_CHANGES;
  }

  const hideCod: CartPaymentMethodsTransformRunResult = {
    operations: codMethods.map((method) => ({
      paymentMethodHide: { paymentMethodId: method.id },
    })),
  };

  // COD stays visible — restate its name with the fee the app currently
  // charges. Skipped entirely when no fee is configured, or when the name
  // already reads that way, so a shop that never touched /app/cod-settings
  // keeps exactly the label its merchant typed.
  const feeAmount = configuration.feeAmount;
  const showCod: CartPaymentMethodsTransformRunResult =
    typeof feeAmount === "number" && feeAmount > 0
      ? {
          operations: codMethods
            .map((method) => ({
              method,
              name: withFeeSuffix(method.name, feeAmount),
            }))
            .filter(({ method, name }) => name !== method.name)
            .map(({ method, name }) => ({
              paymentMethodRename: { paymentMethodId: method.id, name },
            })),
        }
      : NO_CHANGES;

  const subtotal = Number(input.cart.cost.subtotalAmount.amount);
  if (!(subtotal >= minimumAmount)) {
    return hideCod;
  }
  const maximumAmount = configuration.maximumAmount;
  if (typeof maximumAmount === "number" && subtotal > maximumAmount) {
    return hideCod;
  }

  const address = input.cart.deliveryGroups[0]?.deliveryAddress;
  if (!address || address.countryCode !== "PH") {
    return hideCod;
  }

  // Primary signal: ZIP validated against the Metro Manila masterlist.
  const zipMatch = zipInRanges(address.zip ?? "", zipRanges);
  if (zipMatch !== null) {
    return zipMatch ? showCod : hideCod;
  }

  // Fallback (ZIP missing/malformed): normalized free-text city.
  const normalized = normalizeCity(address.city ?? "");
  const canonical = aliases[normalized] ?? normalized;
  return cities.includes(canonical) ? showCod : hideCod;
}
