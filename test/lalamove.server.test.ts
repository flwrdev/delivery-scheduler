import { describe, expect, it } from "vitest";

import {
  parseLalamoveError,
  sanitizeCoordinate,
} from "../app/lib/lalamove.server";

describe("sanitizeCoordinate", () => {
  it("formats a normal decimal to 6 places", () => {
    expect(sanitizeCoordinate("14.5995", "latitude")).toBe("14.599500");
    expect(sanitizeCoordinate("120.9842", "longitude")).toBe("120.984200");
  });

  it("normalizes high-precision stored coordinates (the real Bug 1 case)", () => {
    // Values pulled from live Lalamove Settings — long precision strings.
    expect(sanitizeCoordinate("14.6318942183155", "latitude")).toBe("14.631894");
    expect(sanitizeCoordinate("120.96987720940528", "longitude")).toBe(
      "120.969877",
    );
  });

  it("collapses scientific notation into a plain decimal", () => {
    // String(0.0000123) === "0.0000123" but tiny floats can render as 1.23e-5.
    expect(sanitizeCoordinate(1.23e-5, "latitude")).toBe("0.000012");
    expect(sanitizeCoordinate("1.23e-5", "longitude")).toBe("0.000012");
  });

  it("never returns scientific notation", () => {
    const out = sanitizeCoordinate(0.0000001, "latitude");
    expect(out).not.toMatch(/e/i);
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeCoordinate("  14.5995  ", "latitude")).toBe("14.599500");
  });

  it("accepts a number input directly", () => {
    expect(sanitizeCoordinate(14.5995, "latitude")).toBe("14.599500");
  });

  it("throws a friendly error for non-numeric input", () => {
    expect(() => sanitizeCoordinate("abc", "latitude")).toThrow(/Invalid latitude/);
    expect(() => sanitizeCoordinate("", "longitude")).toThrow(/Invalid longitude/);
  });

  it("throws for NaN", () => {
    expect(() => sanitizeCoordinate(NaN, "latitude")).toThrow(/Invalid latitude/);
  });

  it("rejects out-of-range latitude (> 90)", () => {
    expect(() => sanitizeCoordinate(91, "latitude")).toThrow(/out of range/);
    expect(() => sanitizeCoordinate(-90.0001, "latitude")).toThrow(/out of range/);
  });

  it("rejects out-of-range longitude (> 180)", () => {
    expect(() => sanitizeCoordinate(181, "longitude")).toThrow(/out of range/);
  });

  it("allows the boundary values", () => {
    expect(sanitizeCoordinate(90, "latitude")).toBe("90.000000");
    expect(sanitizeCoordinate(-180, "longitude")).toBe("-180.000000");
  });
});

describe("parseLalamoveError", () => {
  it("maps an invalid-longitude field error to an actionable message", () => {
    const body = JSON.stringify({
      errors: [{ id: "ERR_INVALID_FIELD", detail: "/data/stops/0/coordinates/lng" }],
    });
    expect(parseLalamoveError(422, body)).toMatch(/longitude/i);
  });

  it("maps an invalid-latitude field error", () => {
    const body = JSON.stringify({
      errors: [{ id: "ERR_INVALID_FIELD", detail: "/data/stops/0/coordinates/lat" }],
    });
    expect(parseLalamoveError(422, body)).toMatch(/latitude/i);
  });

  it("maps an invalid specialRequests error", () => {
    const body = JSON.stringify({
      errors: [{ id: "ERR_INVALID_FIELD", detail: "/data/specialRequests/0" }],
    });
    expect(parseLalamoveError(422, body)).toMatch(/special request/i);
  });

  it("maps known top-level error ids to friendly text", () => {
    expect(
      parseLalamoveError(401, JSON.stringify({ errors: [{ id: "ERR_UNAUTHORIZED" }] })),
    ).toMatch(/authentication/i);
    expect(
      parseLalamoveError(
        422,
        JSON.stringify({ errors: [{ id: "ERR_INSUFFICIENT_STOPS" }] }),
      ),
    ).toMatch(/pickup or delivery/i);
  });

  it("joins multiple errors", () => {
    const body = JSON.stringify({
      errors: [
        { id: "ERR_INVALID_FIELD", detail: "/data/stops/0/coordinates/lng" },
        { id: "ERR_UNAUTHORIZED" },
      ],
    });
    const msg = parseLalamoveError(422, body);
    expect(msg).toMatch(/longitude/i);
    expect(msg).toMatch(/authentication/i);
    expect(msg).toContain(";");
  });

  it("falls back gracefully on non-JSON bodies", () => {
    expect(parseLalamoveError(500, "<html>gateway timeout</html>")).toMatch(
      /Request failed \[500\]/,
    );
  });

  it("handles an empty errors array", () => {
    expect(parseLalamoveError(400, JSON.stringify({ errors: [] }))).toMatch(
      /Request failed \(400\)/,
    );
  });
});
