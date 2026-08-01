// Delivery-coverage lookup for the FlowerCart Messenger agent.
//
// Backed by the merchant's own zip/barangay list (Google Drive
// "zip code - Sheet1.csv" — the same copy they use for local delivery),
// generated into app/data/ncr-zipcodes.ts. Pure in-process lookup: no
// external API in the conversation hot path (architecture rule), no
// Google Maps dependency.
//
// Answers "saan kayo nagde-deliver / covered ba kami?" and, for entries with
// baked coordinates, an ESTIMATED fee (haversine x road factor through the
// Lalamove motorcycle bands + handling fee). The exact fee is always the
// Lalamove-calculated shipping rate at checkout — the agent may quote the
// estimate only as "tantiya".

import { NCR_ZIP_ENTRIES } from "../data/ncr-zipcodes";
import type { NcrZipEntry } from "../data/ncr-zipcodes";

const MAX_MATCHES = 8;

// The Flowercart pickup point (merchant-provided) and the Lalamove motorcycle
// dynamic-price bands + the merchant's Shopify handling fee. The estimate is
// straight-line distance x a road factor — close to but never exactly the
// Lalamove-routed checkout fee; the agent must present it as an ESTIMATE.
export const PICKUP_POINT = { lat: 14.63226007982472, lng: 120.96984450954608 };
const ROAD_FACTOR = 1.4;
const BASE_FARE_PHP = 49;
const PER_KM_FIRST5_PHP = 6;
const PER_KM_BEYOND5_PHP = 5;
const HANDLING_FEE_PHP = 40;

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function estimateDeliveryFeePhp(roadKm: number): number {
  const first = Math.min(roadKm, 5) * PER_KM_FIRST5_PHP;
  const beyond = Math.max(0, roadKm - 5) * PER_KM_BEYOND5_PHP;
  return Math.round(BASE_FARE_PHP + first + beyond + HANDLING_FEE_PHP);
}

export interface CoverageMatch extends NcrZipEntry {
  estimatedKm?: number;
  estimatedFeePhp?: number;
}

export interface CheckDeliveryCoverageInput {
  zip?: string;
  area?: string;
}

export type CheckDeliveryCoverageResult =
  | { ok: true; covered: true; matches: CoverageMatch[]; feeNote: string }
  | { ok: true; covered: false; note: string }
  | { ok: false; error: string };

const FEE_NOTE =
  "Estimated fee only (straight-line based) — the exact fee is computed by Lalamove at checkout. Free shipping on orders P2,500 and up.";

function toMatch(entry: NcrZipEntry): CoverageMatch {
  if (entry.lat === undefined || entry.lng === undefined) {
    return { ...entry };
  }
  const roadKm =
    Math.round(haversineKm(PICKUP_POINT, { lat: entry.lat, lng: entry.lng }) * ROAD_FACTOR * 10) /
    10;
  return { ...entry, estimatedKm: roadKm, estimatedFeePhp: estimateDeliveryFeePhp(roadKm) };
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NORMALIZED_ENTRIES = NCR_ZIP_ENTRIES.map((entry) => ({
  entry,
  areaNorm: normalize(entry.area),
  cityNorm: normalize(entry.city),
}));

// Common customer spellings that don't appear verbatim in the merchant's sheet.
const AREA_ALIASES: Record<string, string> = {
  bgc: "fort bonifacio",
  "bonifacio global city": "fort bonifacio",
  "the fort": "fort bonifacio",
  qc: "quezon city",
  kalookan: "caloocan",
  maynila: "manila",
  "las pinas city": "las pinas",
};

export function checkDeliveryCoverage(
  input: CheckDeliveryCoverageInput,
): CheckDeliveryCoverageResult {
  const zipDigits = (input.zip ?? "").replace(/\D+/g, "");
  let areaNorm = normalize(input.area ?? "");
  areaNorm = AREA_ALIASES[areaNorm] ?? areaNorm;

  if (!zipDigits && !areaNorm) {
    return { ok: false, error: "Provide a zip code or a barangay/area/city name." };
  }

  if (zipDigits) {
    const matches = NORMALIZED_ENTRIES.filter(({ entry }) => entry.zip === zipDigits)
      .map(({ entry }) => toMatch(entry))
      .slice(0, MAX_MATCHES);
    if (matches.length) {
      return { ok: true, covered: true, matches, feeNote: FEE_NOTE };
    }
    if (!areaNorm) {
      return {
        ok: true,
        covered: false,
        note: `Zip ${zipDigits} is not in the Metro Manila delivery list.`,
      };
    }
  }

  if (areaNorm) {
    // City-level match first, then area substring both directions.
    const cityMatches = NORMALIZED_ENTRIES.filter(
      ({ cityNorm }) => cityNorm === areaNorm || areaNorm.includes(cityNorm),
    );
    const pool = cityMatches.length
      ? cityMatches
      : NORMALIZED_ENTRIES.filter(
          ({ areaNorm: candidate }) =>
            candidate.includes(areaNorm) || (areaNorm.length >= 4 && areaNorm.includes(candidate)),
        );
    if (pool.length) {
      return {
        ok: true,
        covered: true,
        matches: pool.slice(0, MAX_MATCHES).map((p) => toMatch(p.entry)),
        feeNote: FEE_NOTE,
      };
    }
  }

  return {
    ok: true,
    covered: false,
    note: "That place is not in the Metro Manila delivery list — deliveries are within Metro Manila only.",
  };
}
