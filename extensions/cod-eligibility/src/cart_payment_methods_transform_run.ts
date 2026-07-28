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
  allowedZipRanges?: [number, number][];
  allowedCities?: string[];
  cityAliases?: Record<string, string>;
};

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
    return zipMatch ? NO_CHANGES : hideCod;
  }

  // Fallback (ZIP missing/malformed): normalized free-text city.
  const normalized = normalizeCity(address.city ?? "");
  const canonical = aliases[normalized] ?? normalized;
  return cities.includes(canonical) ? NO_CHANGES : hideCod;
}
