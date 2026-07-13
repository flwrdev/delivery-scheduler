import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Customer Email (customer-email-design.md §6): pins the service param
// mapping (incl. the BCC-self invariant E-3), the config gating, and the
// sendEmail op's validation + recipient-lock (E-4) behavior.

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

import {
  _resetEmailTransportForTests,
  EMAIL_NOT_CONFIGURED_MESSAGE,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  handleSendEmailOp,
  sendCustomerEmail,
} from "../app/services/send-customer-email.server";

const USER = "shop@flowercart.test";

function stubEmailEnv() {
  vi.stubEnv("EMAIL_SMTP_HOST", "mail.privateemail.com");
  vi.stubEnv("EMAIL_SMTP_PORT", "465");
  vi.stubEnv("EMAIL_SMTP_USER", USER);
  vi.stubEnv("EMAIL_SMTP_PASSWORD", "s3cret");
  vi.stubEnv("EMAIL_FROM_NAME", "The Flowercart");
}

beforeEach(() => {
  _resetEmailTransportForTests();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
  createTransportMock.mockClear();
  stubEmailEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(payload: unknown) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
    [];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ query, variables: options?.variables });
      return jsonResponse(payload);
    },
  };
  return { admin, calls };
}

function orderPayload(email: string | null) {
  return {
    data: {
      order: {
        id: "gid://shopify/Order/123",
        customer: email
          ? { defaultEmailAddress: { emailAddress: email } }
          : null,
      },
    },
  };
}

function makeFd(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("_action", "sendEmail");
  fd.set("orderId", "gid://shopify/Order/123");
  fd.set("subject", "Order #1009");
  fd.set("body", "Hello! Your delivery is on the way.");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("sendCustomerEmail", () => {
  it("builds the transport from env and pins From/To/BCC/subject/text (E-3 BCC-self)", async () => {
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "Order #1009",
      textBody: "Hello!",
    });

    expect(result).toEqual({ ok: true });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith({
      host: "mail.privateemail.com",
      port: 465,
      secure: true,
      auth: { user: USER, pass: "s3cret" },
      logger: false,
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith({
      from: { name: "The Flowercart", address: USER },
      to: "cust@example.com",
      bcc: USER,
      subject: "Order #1009",
      text: "Hello!",
    });
  });

  it("reuses one transport across sends (lazy singleton)", async () => {
    await sendCustomerEmail({ to: "a@x.com", subject: "s", textBody: "b" });
    await sendCustomerEmail({ to: "b@x.com", subject: "s", textBody: "b" });
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("port 587 fallback uses STARTTLS (secure: false)", async () => {
    vi.stubEnv("EMAIL_SMTP_PORT", "587");
    await sendCustomerEmail({ to: "a@x.com", subject: "s", textBody: "b" });
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false }),
    );
  });

  it("config gating: missing user/password → clear error, no transport", async () => {
    vi.stubEnv("EMAIL_SMTP_USER", "");
    vi.stubEnv("EMAIL_SMTP_PASSWORD", "");
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result).toEqual({ ok: false, error: EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("maps EAUTH to a human sign-in message", async () => {
    sendMailMock.mockRejectedValueOnce({
      code: "EAUTH",
      message: "535 5.7.8 authentication failed",
    });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rejected the sign-in");
    }
  });

  it("surfaces provider rejections (SMTP response code) with server wording", async () => {
    sendMailMock.mockRejectedValueOnce({
      responseCode: 550,
      message: "hourly sending limit exceeded",
    });
    const result = await sendCustomerEmail({
      to: "cust@example.com",
      subject: "s",
      textBody: "b",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rejected the message");
      expect(result.error).toContain("hourly sending limit exceeded");
    }
  });
});

describe("handleSendEmailOp", () => {
  it("happy path: re-reads the customer email and ignores any client-supplied recipient (E-4)", async () => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    // A spoofed "to" field must have zero effect on the recipient.
    const fd = makeFd({ to: "evil@attacker.test" });

    const res = await handleSendEmailOp(admin, fd);
    const j = (await res.json()) as { ok: boolean; message: string };

    expect(res.status).toBe(200);
    expect(j).toEqual({ ok: true, message: "Email sent to cust@example.com." });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ id: "gid://shopify/Order/123" });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "cust@example.com", bcc: USER }),
    );
  });

  it.each([
    ["missing", ""],
    ["numeric", "123"],
    ["non-order gid", "gid://shopify/Product/123"],
  ])("rejects a %s orderId without touching the API", async (_label, id) => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd({ orderId: id }));
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j.ok).toBe(false);
    expect(j.message).toBe("Invalid order ID.");
    expect(calls).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty subject", { subject: "   " }, "Enter a subject."],
    [
      "oversized subject",
      { subject: "x".repeat(MAX_EMAIL_SUBJECT_LENGTH + 1) },
      `Subject must be ${MAX_EMAIL_SUBJECT_LENGTH} characters or fewer.`,
    ],
    ["empty body", { body: "  " }, "Enter a message."],
    [
      "oversized body",
      { body: "x".repeat(MAX_EMAIL_BODY_LENGTH + 1) },
      `Message must be ${MAX_EMAIL_BODY_LENGTH} characters or fewer.`,
    ],
  ])("rejects %s with a 400", async (_label, overrides, message) => {
    const { admin, calls } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd(overrides));
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j).toEqual({ ok: false, message });
    expect(calls).toHaveLength(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("400 when the order has no customer email", async () => {
    const { admin } = makeAdmin(orderPayload(null));
    const res = await handleSendEmailOp(admin, makeFd());
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(400);
    expect(j).toEqual({
      ok: false,
      message: "This order has no customer email.",
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("404 when the order does not exist", async () => {
    const { admin } = makeAdmin({ data: { order: null } });
    const res = await handleSendEmailOp(admin, makeFd());
    expect(res.status).toBe(404);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j).toEqual({ ok: false, message: "Order not found." });
  });

  // Upstream failures come back as 200 + ok:false, NEVER 5xx — Cloudflare
  // replaces origin 502/504 bodies with its branded HTML error page, which
  // breaks the fetcher JSON contract (observed live via the dev tunnel).
  it("200 + ok:false when the order read returns GraphQL errors", async () => {
    const { admin } = makeAdmin({ errors: [{ message: "boom" }] });
    const res = await handleSendEmailOp(admin, makeFd());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.message).toContain("Couldn't read the order: boom");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("200 + ok:false with the humanized message when the send fails", async () => {
    sendMailMock.mockRejectedValueOnce({ code: "EAUTH", message: "535" });
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j.ok).toBe(false);
    expect(j.message).toContain("rejected the sign-in");
  });

  it("200 + ok:false with the not-configured message when env is absent (config gating)", async () => {
    vi.stubEnv("EMAIL_SMTP_USER", "");
    vi.stubEnv("EMAIL_SMTP_PASSWORD", "");
    const { admin } = makeAdmin(orderPayload("cust@example.com"));
    const res = await handleSendEmailOp(admin, makeFd());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; message: string };
    expect(j).toEqual({ ok: false, message: EMAIL_NOT_CONFIGURED_MESSAGE });
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});
