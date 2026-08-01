// Delivery-coverage lookup for the FlowerCart Messenger agent.
//
// Backed by the merchant's own zip/barangay list (Google Drive
// "zip code - Sheet1.csv" — the same copy they use for local delivery),
// generated into app/data/ncr-zipcodes.ts. Pure in-process lookup: no
// external API in the conversation hot path (architecture rule), no
// Google Maps dependency.
//
// This answers "saan kayo nagde-deliver / covered ba kami?" — it does NOT
// compute the peso fee (base fare P90 + P6/km needs a distance source; the
// agent states the formula and defers the exact total to checkout/staff).

import { NCR_ZIP_ENTRIES } from "../data/ncr-zipcodes";
import type { NcrZipEntry } from "../data/ncr-zipcodes";

const MAX_MATCHES = 8;

export interface CheckDeliveryCoverageInput {
  zip?: string;
  area?: string;
}

export type CheckDeliveryCoverageResult =
  | { ok: true; covered: true; matches: NcrZipEntry[] }
  | { ok: true; covered: false; note: string }
  | { ok: false; error: string };

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

export function checkDeliveryCoverage(
  input: CheckDeliveryCoverageInput,
): CheckDeliveryCoverageResult {
  const zipDigits = (input.zip ?? "").replace(/\D+/g, "");
  const areaNorm = normalize(input.area ?? "");

  if (!zipDigits && !areaNorm) {
    return { ok: false, error: "Provide a zip code or a barangay/area/city name." };
  }

  if (zipDigits) {
    const matches = NORMALIZED_ENTRIES.filter(({ entry }) => entry.zip === zipDigits)
      .map(({ entry }) => entry)
      .slice(0, MAX_MATCHES);
    if (matches.length) {
      return { ok: true, covered: true, matches };
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
      return { ok: true, covered: true, matches: pool.slice(0, MAX_MATCHES).map((p) => p.entry) };
    }
  }

  return {
    ok: true,
    covered: false,
    note: "That place is not in the Metro Manila delivery list — deliveries are within Metro Manila only.",
  };
}
