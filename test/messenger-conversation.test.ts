import { describe, expect, it } from "vitest";

import {
  MESSENGER_PSID_ATTRIBUTE,
  buildMessengerInboxUrl,
  getMessengerPsid,
  isMessengerSourced,
} from "../app/lib/messenger-conversation";

describe("getMessengerPsid", () => {
  it("reads the hidden PSID attribute", () => {
    expect(getMessengerPsid({ customAttributes: [{ key: MESSENGER_PSID_ATTRIBUTE, value: " 100000493184591 " }] })).toBe(
      "100000493184591",
    );
  });

  it("returns null when absent, empty, or not numeric", () => {
    expect(getMessengerPsid({ customAttributes: [] })).toBeNull();
    expect(getMessengerPsid({ customAttributes: null })).toBeNull();
    expect(getMessengerPsid({ customAttributes: [{ key: MESSENGER_PSID_ATTRIBUTE, value: "abc" }] })).toBeNull();
    expect(getMessengerPsid({ customAttributes: [{ key: MESSENGER_PSID_ATTRIBUTE, value: null }] })).toBeNull();
  });
});

describe("isMessengerSourced", () => {
  it("matches the source:messenger tag case-insensitively", () => {
    expect(isMessengerSourced({ tags: ["2026-09-12", "Source:Messenger"] })).toBe(true);
    expect(isMessengerSourced({ tags: ["source:instagram"] })).toBe(false);
    expect(isMessengerSourced({ tags: null })).toBe(false);
  });
});

describe("buildMessengerInboxUrl", () => {
  it("builds the conversation URL with mailbox, PSID, and thread type", () => {
    const url = buildMessengerInboxUrl("105284684761365", "100000493184591");
    expect(url).toBe(
      "https://business.facebook.com/latest/inbox/all/?mailbox_id=105284684761365&selected_item_id=100000493184591&thread_type=FB_MESSAGE",
    );
  });

  it("builds the inbox-only URL without a PSID", () => {
    expect(buildMessengerInboxUrl("105284684761365")).toBe(
      "https://business.facebook.com/latest/inbox/all/?mailbox_id=105284684761365",
    );
  });

  it("returns null for a malformed page id", () => {
    expect(buildMessengerInboxUrl("")).toBeNull();
    expect(buildMessengerInboxUrl("page-name")).toBeNull();
  });
});
