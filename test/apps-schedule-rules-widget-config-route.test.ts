import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /apps/schedule-rules/widget-config — App-Proxy-signed config endpoint
// the storefront widget fetches before mounting (2026-08-23). Same signing
// idiom as test/apps-schedule-rules-support-chat-route.test.ts (real
// verifyAppProxySignature, hand-signed fixtures); loadWidgetConfig is mocked
// so this suite never touches a real DB.

const { loadWidgetConfigMock } = vi.hoisted(() => ({
  loadWidgetConfigMock: vi.fn(),
}));

vi.mock("../app/services/widget-config.server", () => ({
  loadWidgetConfig: loadWidgetConfigMock,
}));

import { loader } from "../app/routes/apps.schedule-rules.widget-config";

const SECRET = "hush";
const SHOP = "hsrwva-nr.myshopify.com";

function sign(params: URLSearchParams, secret: string): string {
  const sorted = [...new Set(params.keys())]
    .sort()
    .map((key) => `${key}=${params.getAll(key).join(",")}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

function signedUrl(extraParams: Record<string, string> = {}, { secret = SECRET, shop = SHOP } = {}): string {
  const params = new URLSearchParams({
    shop,
    path_prefix: "/apps/schedule-rules",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extraParams,
  });
  params.set("signature", sign(params, secret));
  return `https://app.example.com/apps/schedule-rules/widget-config?${params.toString()}`;
}

async function callLoader(url: string) {
  return (await loader({ request: new Request(url), params: {}, context: {} } as never)) as Response;
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_SECRET", SECRET);
  vi.stubEnv("MESSENGER_SHOP", SHOP);
  loadWidgetConfigMock.mockReset();
  loadWidgetConfigMock.mockResolvedValue({
    greeting: "Hi!",
    bubbleColor: "#9a6a60",
    supportPhone: "0962 422 4085",
    trackLabel: "Track",
    chips: [
      { label: "L2", message: "M2" },
      { label: "L3", message: "M3" },
      { label: "L4", message: "M4" },
    ],
    panelBg: "#ffffff",
    textColor: "#3b3230",
    mutedColor: "#6d6560",
    borderColor: "#e9ded9",
    panelSize: "standard",
    cornerRadius: 16,
    position: "right",
    disclaimerText: "Sinasagot ito ng AI — maaaring magkamali paminsan-minsan.",
    showDisclaimer: true,
    autoHideBubble: false,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("apps.schedule-rules.widget-config loader — signature + shop verification", () => {
  it("rejects a missing/invalid signature with 401 before touching the config", async () => {
    const url = signedUrl().replace(/signature=[0-9a-f]+/, "signature=deadbeef");
    const res = await callLoader(url);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" });
    expect(loadWidgetConfigMock).not.toHaveBeenCalled();
  });

  it("rejects a shop that does not match MESSENGER_SHOP with 401", async () => {
    const url = signedUrl({}, { shop: "some-other-shop.myshopify.com" });
    const res = await callLoader(url);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: "shop_mismatch" });
    expect(loadWidgetConfigMock).not.toHaveBeenCalled();
  });
});

describe("apps.schedule-rules.widget-config loader — happy path", () => {
  it("returns the config shaped for the widget, with track_order first", async () => {
    const res = await callLoader(signedUrl());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      greeting: "Hi!",
      bubbleColor: "#9a6a60",
      supportPhone: "0962 422 4085",
      chips: [
        { action: "track_order", label: "Track" },
        { label: "L2", message: "M2" },
        { label: "L3", message: "M3" },
        { label: "L4", message: "M4" },
      ],
      panelBg: "#ffffff",
      textColor: "#3b3230",
      mutedColor: "#6d6560",
      borderColor: "#e9ded9",
      panelSize: "standard",
      cornerRadius: 16,
      position: "right",
      disclaimerText: "Sinasagot ito ng AI — maaaring magkamali paminsan-minsan.",
      showDisclaimer: true,
      autoHideBubble: false,
    });
    expect(loadWidgetConfigMock).toHaveBeenCalledWith(SHOP);
  });

  it("sets a 5-minute Cache-Control header", async () => {
    const res = await callLoader(signedUrl());
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
