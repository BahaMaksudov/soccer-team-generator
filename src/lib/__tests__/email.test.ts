import { describe, it, expect, vi, afterEach } from "vitest";
import { appUrl, EmailConfigError, getAppBaseUrl, getEmailFrom } from "@/lib/email/config";
import {
  createMemoryTransport,
  createResendTransport,
  EmailDeliveryError,
  getEmailTransport,
  RESEND_ENDPOINT,
  setEmailTransportForTests,
  testOutbox,
} from "@/lib/email/transport";
import { buildInvitationEmail, buildVerificationEmail } from "@/lib/email/templates";
import { sendInvitationEmail, sendVerificationEmail } from "@/lib/email";

const API_KEY = "re_test_key_never_logged";
const TOKEN = "A".repeat(43);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setEmailTransportForTests(null);
  testOutbox.clear();
});

describe("APP_BASE_URL / EMAIL_FROM configuration", () => {
  it("production requires an https origin and never falls back", () => {
    expect(getAppBaseUrl({ NODE_ENV: "production", APP_BASE_URL: "https://teambalancepro.com" })).toBe("https://teambalancepro.com");
    expect(getAppBaseUrl({ NODE_ENV: "production", APP_BASE_URL: "https://teambalancepro.com/" })).toBe("https://teambalancepro.com");
    for (const bad of [undefined, "", "http://teambalancepro.com", "https://localhost", "https://teambalancepro.com/app", "https://u:p@teambalancepro.com", "https://x.com?a=1", "not a url"]) {
      expect(() => getAppBaseUrl({ NODE_ENV: "production", APP_BASE_URL: bad }), String(bad)).toThrow(EmailConfigError);
    }
  });

  it("development/test accept an explicit http(s) origin", () => {
    expect(getAppBaseUrl({ NODE_ENV: "development", APP_BASE_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(() => getAppBaseUrl({ NODE_ENV: "test" })).toThrow(EmailConfigError);
    expect(() => getAppBaseUrl({ NODE_ENV: "test", APP_BASE_URL: "ftp://x.test" })).toThrow(EmailConfigError);
  });

  it("appUrl only joins internal paths", () => {
    const env = { NODE_ENV: "production", APP_BASE_URL: "https://teambalancepro.com" };
    expect(appUrl("/invite/x", env)).toBe("https://teambalancepro.com/invite/x");
    expect(() => appUrl("//evil.example/x", env)).toThrow(EmailConfigError);
    expect(() => appUrl("https://evil.example", env)).toThrow(EmailConfigError);
  });

  it("EMAIL_FROM must be set and single-line", () => {
    expect(getEmailFrom({ EMAIL_FROM: "Team Balance Pro <no-reply@mail.teambalancepro.com>" })).toBe(
      "Team Balance Pro <no-reply@mail.teambalancepro.com>"
    );
    expect(() => getEmailFrom({})).toThrow(EmailConfigError);
    expect(() => getEmailFrom({ EMAIL_FROM: "a@b.com\r\nBcc: x@y.com" })).toThrow(EmailConfigError);
  });
});

describe("Resend transport (fetch, no SDK)", () => {
  const message = { from: "Team Balance Pro <no-reply@mail.teambalancepro.com>", to: "a@example.com", subject: "S", text: `T ${TOKEN}`, html: `<p>${TOKEN}</p>` };

  it("POSTs to the Resend API with the bearer key and the message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await createResendTransport({ apiKey: API_KEY, fetchImpl }).send(message);
    expect(result).toEqual({ providerMessageId: "msg_123" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ from: message.from, to: ["a@example.com"], subject: "S", text: message.text, html: message.html });
  });

  it("non-2xx → EmailDeliveryError; logs only provider + status (no key, body or token)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: `invalid key ${API_KEY}` }), { status: 401 }));
    await expect(createResendTransport({ apiKey: API_KEY, fetchImpl }).send(message)).rejects.toMatchObject({ reason: "http", status: 401 });
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("provider=resend");
    expect(logged).toContain("401");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(TOKEN);
  });

  it("network error and timeout → EmailDeliveryError", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const network = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createResendTransport({ apiKey: API_KEY, fetchImpl: network }).send(message)).rejects.toMatchObject({ reason: "network" });
    const slow = vi.fn((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
    );
    await expect(
      createResendTransport({ apiKey: API_KEY, fetchImpl: slow as unknown as typeof fetch, timeoutMs: 20 }).send(message)
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("a 2xx with a malformed body counts as accepted (id unknown) and is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    expect(await createResendTransport({ apiKey: API_KEY, fetchImpl }).send(message)).toEqual({ providerMessageId: null });
    expect(warn).toHaveBeenCalled();
  });
});

describe("transport selection — tests can never reach the network", () => {
  it("NODE_ENV=test always uses the in-memory outbox, even with an API key present", () => {
    expect(getEmailTransport({ NODE_ENV: "test", RESEND_API_KEY: API_KEY })).toBe(testOutbox);
  });
  it("production uses Resend and fails closed without RESEND_API_KEY", () => {
    expect(getEmailTransport({ NODE_ENV: "production", RESEND_API_KEY: API_KEY }).name).toBe("resend");
    expect(() => getEmailTransport({ NODE_ENV: "production" })).toThrow(EmailConfigError);
  });
  it("the test override wins", () => {
    const t = createMemoryTransport();
    setEmailTransportForTests(t);
    expect(getEmailTransport({ NODE_ENV: "production", RESEND_API_KEY: API_KEY })).toBe(t);
  });
});

describe("email content", () => {
  const exp = new Date("2026-10-01T12:00:00Z");

  it("verification: Team Balance Pro, purpose, expiry, link; escapes HTML", () => {
    const m = buildVerificationEmail({ to: "a@example.com", name: "<b>Ann</b>", url: `https://teambalancepro.com/verify-email/${TOKEN}`, expiresAt: exp });
    expect(m.subject).toBe("Verify your email for Team Balance Pro");
    expect(m.text).toContain(`https://teambalancepro.com/verify-email/${TOKEN}`);
    expect(m.text).toMatch(/expires on October 1, 2026/);
    expect(m.html).toContain("Team Balance Pro");
    expect(m.html).not.toContain("<b>Ann</b>");
    expect(m.html).toContain("&lt;b&gt;Ann&lt;/b&gt;");
  });

  it("invitation: organization, inviter, role, expiry, link", () => {
    const m = buildInvitationEmail({ to: "b@example.com", organizationName: "New England Eagles", inviterName: "Bahrom", role: "ADMIN", url: `https://teambalancepro.com/invite/${TOKEN}`, expiresAt: exp });
    expect(m.subject).toBe("You're invited to join New England Eagles on Team Balance Pro");
    expect(m.text).toContain("Bahrom invited you to join New England Eagles on Team Balance Pro as ADMIN");
    expect(m.text).toContain(`https://teambalancepro.com/invite/${TOKEN}`);
    expect(m.text).toMatch(/expires on October 1, 2026/);
  });
});

describe("sendVerificationEmail / sendInvitationEmail", () => {
  it("build links on APP_BASE_URL with EMAIL_FROM, through the in-memory outbox", async () => {
    vi.stubEnv("APP_BASE_URL", "https://teambalancepro.com");
    vi.stubEnv("EMAIL_FROM", "Team Balance Pro <no-reply@mail.teambalancepro.com>");
    await sendVerificationEmail({ to: "a@example.com", name: null, token: TOKEN, expiresAt: new Date(), next: `/invite/${"B".repeat(43)}` });
    await sendInvitationEmail({ to: "b@example.com", organizationName: "Org", inviterName: null, role: "MEMBER", token: TOKEN, expiresAt: new Date() });
    expect(testOutbox.sent.map((m) => m.from)).toEqual([
      "Team Balance Pro <no-reply@mail.teambalancepro.com>",
      "Team Balance Pro <no-reply@mail.teambalancepro.com>",
    ]);
    expect(testOutbox.sent[0].text).toContain(
      `https://teambalancepro.com/verify-email/${TOKEN}?next=${encodeURIComponent(`/invite/${"B".repeat(43)}`)}`
    );
    expect(testOutbox.sent[1].text).toContain(`https://teambalancepro.com/invite/${TOKEN}`);
  });

  it("an external continuation is dropped from the verification link (no open redirect)", async () => {
    vi.stubEnv("APP_BASE_URL", "https://teambalancepro.com");
    vi.stubEnv("EMAIL_FROM", "x@teambalancepro.com");
    await sendVerificationEmail({ to: "a@example.com", name: null, token: TOKEN, expiresAt: new Date(), next: "https://evil.example" });
    expect(testOutbox.sent[0].text).toContain(`https://teambalancepro.com/verify-email/${TOKEN}\n`);
    expect(testOutbox.sent[0].text).not.toContain("evil");
  });

  it("missing configuration fails closed (no email, no Host-header fallback)", async () => {
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("EMAIL_FROM", "x@teambalancepro.com");
    await expect(sendInvitationEmail({ to: "b@example.com", organizationName: "Org", inviterName: null, role: "MEMBER", token: TOKEN, expiresAt: new Date() })).rejects.toThrow(EmailConfigError);
    expect(testOutbox.sent).toHaveLength(0);
  });

  it("EmailDeliveryError is a typed, safe error", () => {
    const e = new EmailDeliveryError("http", 500);
    expect(e.message).toBe("Email delivery failed (http 500).");
  });
});
