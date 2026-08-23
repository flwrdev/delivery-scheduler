// Merchant-editable storefront widget copy (greeting/bubble color/support
// phone/starter chips), set on the Messenger admin page. Same mocking idiom
// as test/agent-rate-limit.server.test.ts: stub prisma, never touch a real
// DB. Two things matter: (1) a null column falls back to the exact built-in
// default the widget already used, (2) any DB failure degrades to the full
// default set rather than breaking the widget.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    widgetConfig: { findUnique: vi.fn() },
  },
}));

vi.mock("../app/db.server", () => ({ default: prismaMock }));

import {
  WIDGET_CONFIG_DEFAULTS,
  loadWidgetConfig,
  resetWidgetConfigCache,
} from "../app/services/widget-config.server";

const SHOP = "hsrwva-nr.myshopify.com";

beforeEach(() => {
  resetWidgetConfigCache();
  prismaMock.widgetConfig.findUnique.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWidgetConfig", () => {
  it("returns the built-in defaults when no row exists", async () => {
    prismaMock.widgetConfig.findUnique.mockResolvedValueOnce(null);

    await expect(loadWidgetConfig(SHOP)).resolves.toEqual(WIDGET_CONFIG_DEFAULTS);
  });

  it("uses every saved field when the row is fully populated", async () => {
    prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({
      shop: SHOP,
      greeting: "Kumusta! Tanong lang.",
      bubbleColor: "#ff0000",
      supportPhone: "0900 000 0000",
      trackLabel: "Track it",
      chip2Label: "L2",
      chip2Message: "M2",
      chip3Label: "L3",
      chip3Message: "M3",
      chip4Label: "L4",
      chip4Message: "M4",
      panelBg: "#111111",
      textColor: "#222222",
      mutedColor: "#333333",
      borderColor: "#444444",
      panelSize: "large",
      cornerRadius: 20,
      position: "left",
      disclaimerText: "Custom disclaimer.",
      showDisclaimer: false,
      autoHideBubble: true,
      updatedAt: new Date(),
    });

    await expect(loadWidgetConfig(SHOP)).resolves.toEqual({
      greeting: "Kumusta! Tanong lang.",
      bubbleColor: "#ff0000",
      supportPhone: "0900 000 0000",
      trackLabel: "Track it",
      chips: [
        { label: "L2", message: "M2" },
        { label: "L3", message: "M3" },
        { label: "L4", message: "M4" },
      ],
      panelBg: "#111111",
      textColor: "#222222",
      mutedColor: "#333333",
      borderColor: "#444444",
      panelSize: "large",
      cornerRadius: 20,
      position: "left",
      disclaimerText: "Custom disclaimer.",
      showDisclaimer: false,
      autoHideBubble: true,
    });
  });

  it("falls back to defaults for an invalid panelSize/position and clamps an out-of-range cornerRadius", async () => {
    prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({
      shop: SHOP,
      panelSize: "gigantic",
      position: "up",
      cornerRadius: 999,
    });

    const result = await loadWidgetConfig(SHOP);
    expect(result.panelSize).toBe(WIDGET_CONFIG_DEFAULTS.panelSize);
    expect(result.position).toBe(WIDGET_CONFIG_DEFAULTS.position);
    expect(result.cornerRadius).toBe(28); // clamped to CORNER_RADIUS_MAX
  });

  // A blank string is functionally "revert to default" — the admin action
  // writes null on blank, but a defensive per-field fallback still matters
  // here in case a row somehow carries an empty string.
  it("falls back per-field when a column is null or blank", async () => {
    prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({
      shop: SHOP,
      greeting: null,
      bubbleColor: "",
      supportPhone: "0900 000 0000",
      trackLabel: null,
      chip2Label: "Custom label",
      chip2Message: null,
      chip3Label: null,
      chip3Message: null,
      chip4Label: null,
      chip4Message: null,
      panelBg: null,
      textColor: null,
      mutedColor: null,
      borderColor: "",
      panelSize: null,
      cornerRadius: null,
      position: null,
      disclaimerText: null,
      showDisclaimer: null,
      autoHideBubble: null,
      updatedAt: new Date(),
    });

    const result = await loadWidgetConfig(SHOP);

    expect(result.greeting).toBe(WIDGET_CONFIG_DEFAULTS.greeting);
    expect(result.bubbleColor).toBe(WIDGET_CONFIG_DEFAULTS.bubbleColor);
    expect(result.supportPhone).toBe("0900 000 0000");
    expect(result.trackLabel).toBe(WIDGET_CONFIG_DEFAULTS.trackLabel);
    expect(result.chips[0]).toEqual({
      label: "Custom label",
      message: WIDGET_CONFIG_DEFAULTS.chips[0].message,
    });
    expect(result.chips[1]).toEqual(WIDGET_CONFIG_DEFAULTS.chips[1]);
    expect(result.chips[2]).toEqual(WIDGET_CONFIG_DEFAULTS.chips[2]);
    expect(result.panelBg).toBe(WIDGET_CONFIG_DEFAULTS.panelBg);
    expect(result.textColor).toBe(WIDGET_CONFIG_DEFAULTS.textColor);
    expect(result.mutedColor).toBe(WIDGET_CONFIG_DEFAULTS.mutedColor);
    expect(result.borderColor).toBe(WIDGET_CONFIG_DEFAULTS.borderColor);
    expect(result.panelSize).toBe(WIDGET_CONFIG_DEFAULTS.panelSize);
    expect(result.cornerRadius).toBe(WIDGET_CONFIG_DEFAULTS.cornerRadius);
    expect(result.position).toBe(WIDGET_CONFIG_DEFAULTS.position);
    expect(result.disclaimerText).toBe(WIDGET_CONFIG_DEFAULTS.disclaimerText);
    expect(result.showDisclaimer).toBe(WIDGET_CONFIG_DEFAULTS.showDisclaimer);
    expect(result.autoHideBubble).toBe(WIDGET_CONFIG_DEFAULTS.autoHideBubble);
  });

  it("respects an explicit false/0 boolean or falsy-but-set value rather than treating it as unset", async () => {
    prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({
      shop: SHOP,
      showDisclaimer: false,
      autoHideBubble: true,
    });

    const result = await loadWidgetConfig(SHOP);
    expect(result.showDisclaimer).toBe(false);
    expect(result.autoHideBubble).toBe(true);
  });

  it("falls back to defaults and warns when the DB read throws", async () => {
    prismaMock.widgetConfig.findUnique.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(loadWidgetConfig(SHOP)).resolves.toEqual(WIDGET_CONFIG_DEFAULTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[widget-config]"));
  });

  describe("caching", () => {
    it("serves a hit from memo without calling prisma again", async () => {
      prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({
        shop: SHOP,
        greeting: "Once",
      });

      await loadWidgetConfig(SHOP, 1_000);
      await loadWidgetConfig(SHOP, 1_000 + 4 * 60 * 1000);

      expect(prismaMock.widgetConfig.findUnique).toHaveBeenCalledTimes(1);
    });

    it("refetches once the 5-minute window closes", async () => {
      prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({ shop: SHOP, greeting: "Old" });
      await loadWidgetConfig(SHOP, 1_000);

      prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({ shop: SHOP, greeting: "New" });
      await expect(loadWidgetConfig(SHOP, 1_000 + 5 * 60 * 1000 + 1)).resolves.toMatchObject({
        greeting: "New",
      });
      expect(prismaMock.widgetConfig.findUnique).toHaveBeenCalledTimes(2);
    });

    it("does not cache a fallback result", async () => {
      prismaMock.widgetConfig.findUnique.mockRejectedValue(new Error("db down"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadWidgetConfig(SHOP, 1_000);
      await loadWidgetConfig(SHOP, 1_000);

      expect(prismaMock.widgetConfig.findUnique).toHaveBeenCalledTimes(2);
    });

    it("keeps two shops from cross-contaminating the memo", async () => {
      prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({ shop: SHOP, greeting: "Shop A" });
      await loadWidgetConfig(SHOP, 1_000);

      prismaMock.widgetConfig.findUnique.mockResolvedValueOnce({ shop: "other.myshopify.com", greeting: "Shop B" });
      await expect(loadWidgetConfig("other.myshopify.com", 1_000)).resolves.toMatchObject({
        greeting: "Shop B",
      });
      expect(prismaMock.widgetConfig.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
