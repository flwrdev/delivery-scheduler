import { describe, expect, it } from "vitest";

import { NCR_ZIP_ENTRIES } from "../app/data/ncr-zipcodes";
import { checkDeliveryCoverage } from "../app/services/messenger-coverage.server";

describe("NCR_ZIP_ENTRIES data", () => {
  it("covers all 17 NCR LGUs with a substantial entry count", () => {
    const cities = new Set(NCR_ZIP_ENTRIES.map((e) => e.city));
    expect(cities.size).toBe(17);
    expect(NCR_ZIP_ENTRIES.length).toBeGreaterThan(300);
  });

  it("has digit-only zips (spaces from the source sheet cleaned)", () => {
    for (const entry of NCR_ZIP_ENTRIES) {
      expect(entry.zip).toMatch(/^\d{3,4}$/);
    }
  });
});

describe("checkDeliveryCoverage", () => {
  it("matches an exact zip code", () => {
    const result = checkDeliveryCoverage({ zip: "1300" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].city).toBe("Pasay");
    }
  });

  it("tolerates spaces and stray text around the zip", () => {
    const result = checkDeliveryCoverage({ zip: " 1209 " });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].city).toBe("Makati");
      expect(result.matches[0].area.toLowerCase()).toContain("bel-air");
    }
  });

  it("reports an unknown zip as not covered", () => {
    const result = checkDeliveryCoverage({ zip: "9999" });
    expect(result).toMatchObject({ ok: true, covered: false });
  });

  it("matches an area/barangay name case- and diacritic-insensitively", () => {
    const result = checkDeliveryCoverage({ area: "BEL AIR" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches[0].zip).toBe("1209");
    }
  });

  it("matches a city name (e.g. the customer just says the city)", () => {
    const result = checkDeliveryCoverage({ area: "Parañaque" });
    expect(result).toMatchObject({ ok: true, covered: true });
    if (result.ok && result.covered) {
      expect(result.matches.every((m) => m.city === "Parañaque")).toBe(true);
    }

    const plain = checkDeliveryCoverage({ area: "paranaque" });
    expect(plain).toMatchObject({ ok: true, covered: true });
  });

  it("caps the number of returned matches", () => {
    const result = checkDeliveryCoverage({ area: "Quezon City" });
    expect(result.ok).toBe(true);
    if (result.ok && result.covered) {
      expect(result.matches.length).toBeLessThanOrEqual(8);
    }
  });

  it("reports an out-of-coverage place as not covered", () => {
    const result = checkDeliveryCoverage({ area: "Cebu City" });
    expect(result).toMatchObject({ ok: true, covered: false });
  });

  it("errors when neither zip nor area is given", () => {
    const result = checkDeliveryCoverage({});
    expect(result.ok).toBe(false);
  });
});
