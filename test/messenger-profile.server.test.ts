import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MESSENGER_GRAPH_API_VERSION,
  MESSENGER_NOT_CONFIGURED_MESSAGE,
} from "../app/services/messenger-send.server";
import {
  MESSENGER_PROFILE_BODY,
  getMessengerProfile,
  setMessengerProfile,
} from "../app/services/messenger-profile.server";

const TOKEN = "test-page-access-token";
const PROFILE_URL = `https://graph.facebook.com/${MESSENGER_GRAPH_API_VERSION}/me/messenger_profile`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("setMessengerProfile", () => {
  it("POSTs the exact profile body (get_started + 4 ice breakers + persistent menu) with the token in the header only", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ result: "success" }));

    const result = await setMessengerProfile();

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PROFILE_URL);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });

    const body = JSON.parse(init.body);
    expect(body).toEqual(MESSENGER_PROFILE_BODY);
    // Pinned shape details (yung mga pinapaasa ng system prompt sa [TAP] rules):
    expect(body.get_started).toEqual({ payload: "GET_STARTED" });
    expect(body.ice_breakers).toHaveLength(1);
    expect(body.ice_breakers[0].locale).toBe("default");
    expect(
      body.ice_breakers[0].call_to_actions.map((cta: { payload: string }) => cta.payload),
    ).toEqual([
      "ICEBREAKER_PRODUCTS",
      "ICEBREAKER_FEE",
      "ICEBREAKER_SAMEDAY",
      "ICEBREAKER_ORDER",
    ]);
    expect(body.persistent_menu).toHaveLength(1);
    expect(body.persistent_menu[0].composer_input_disabled).toBe(false);
    expect(body.persistent_menu[0].call_to_actions).toEqual([
      {
        type: "web_url",
        title: "Tingnan ang mga bulaklak",
        url: "https://flowercart.store/collections/all",
      },
      {
        type: "web_url",
        title: "Delivery coverage",
        url: "https://flowercart.store/pages/delivery-coverage",
      },
      { type: "postback", title: "🛒 Mag-order dito sa chat", payload: "MENU_ORDER" },
    ]);
  });

  it("returns a designed failure without calling fetch when the token is missing", async () => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", "");
    const result = await setMessengerProfile();
    expect(result).toEqual({ ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims the token env value", async () => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", `${TOKEN}\n`);
    fetchMock.mockResolvedValue(jsonResponse({ result: "success" }));
    await setMessengerProfile();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns ok:false with the Graph error message (never the token) on an error response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400),
    );
    const result = await setMessengerProfile();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid OAuth access token.");
      expect(result.error).not.toContain(TOKEN);
    }
  });

  it("returns ok:false without throwing when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await setMessengerProfile();
    expect(result.ok).toBe(false);
  });

  it("returns a timeout error when the request times out", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeoutError);
    const result = await setMessengerProfile();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain("timed out");
  });
});

describe("getMessengerProfile", () => {
  it("GETs the three profile fields with the token in the header only", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            get_started: { payload: "GET_STARTED" },
            ice_breakers: [{ locale: "default", call_to_actions: [{}] }],
            persistent_menu: [{ locale: "default", call_to_actions: [{}] }],
          },
        ],
      }),
    );

    const result = await getMessengerProfile();

    expect(result).toEqual({
      ok: true,
      profile: { hasGetStarted: true, hasIceBreakers: true, hasPersistentMenu: true },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROFILE_URL}?fields=get_started,ice_breakers,persistent_menu`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reports not-set fields when the profile is empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{}] }));
    const result = await getMessengerProfile();
    expect(result).toEqual({
      ok: true,
      profile: { hasGetStarted: false, hasIceBreakers: false, hasPersistentMenu: false },
    });
  });

  it("tolerates an empty data array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const result = await getMessengerProfile();
    expect(result).toEqual({
      ok: true,
      profile: { hasGetStarted: false, hasIceBreakers: false, hasPersistentMenu: false },
    });
  });

  it("returns a designed failure without calling fetch when the token is missing", async () => {
    vi.stubEnv("MESSENGER_PAGE_ACCESS_TOKEN", "");
    const result = await getMessengerProfile();
    expect(result).toEqual({ ok: false, error: MESSENGER_NOT_CONFIGURED_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false (never the token, never a throw) on a Graph error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "Unsupported request.", code: 100 } }, 400),
    );
    const result = await getMessengerProfile();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Unsupported request.");
      expect(result.error).not.toContain(TOKEN);
    }
  });

  it("returns ok:false without throwing when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await getMessengerProfile();
    expect(result.ok).toBe(false);
  });
});
