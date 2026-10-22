import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { oneClickUnsubscribeHeaders, unsubscribeLinks, ONE_CLICK_PATH } from "@/lib/emailSuppression";
import { assertSafeMessageHeaders, createMemoryTransport, createResendTransport } from "@/lib/email/transport";
import { maskEmail } from "@/lib/emailAddress";

/** M13B P3 — unsubscribe links, RFC 8058 headers and the transport's header safety (no network). */
const ENV = { APP_BASE_URL: "https://teambalancepro.com", NODE_ENV: "production" };

describe("unsubscribe links", () => {
  it("website link keeps the token in the fragment; the one-click link is a POST target on APP_BASE_URL", () => {
    const links = unsubscribeLinks("tok_ABC-123", ENV);
    expect(links.page).toBe("https://teambalancepro.com/unsubscribe#tok_ABC-123");
    expect(links.oneClick).toBe(`https://teambalancepro.com${ONE_CLICK_PATH}?t=tok_ABC-123`);
  });
  it("RFC 8058 headers", () => {
    expect(oneClickUnsubscribeHeaders("https://teambalancepro.com/api/email/unsubscribe/one-click?t=x")).toEqual({
      "List-Unsubscribe": "<https://teambalancepro.com/api/email/unsubscribe/one-click?t=x>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});

describe("email header safety", () => {
  it("only the two unsubscribe headers are allowed; values must be single-line", () => {
    expect(() => assertSafeMessageHeaders({ "List-Unsubscribe": "<https://x.test/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" })).not.toThrow();
    expect(() => assertSafeMessageHeaders({ Bcc: "x@y.test" })).toThrow(/not allowed/);
    expect(() => assertSafeMessageHeaders({ "List-Unsubscribe": "<https://x.test/u>\r\nBcc: x@y.test" })).toThrow(/invalid/);
    expect(() => assertSafeMessageHeaders({ "List-Unsubscribe": "" })).toThrow(/invalid/);
    expect(() => assertSafeMessageHeaders(undefined)).not.toThrow();
  });
  it("Resend payload carries the headers; a bad header never reaches the network", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ id: "re_1" }) } as Response;
    }) as unknown as typeof fetch;
    const t = createResendTransport({ apiKey: "re_test", fetchImpl: fakeFetch });
    const headers = oneClickUnsubscribeHeaders("https://teambalancepro.com/api/email/unsubscribe/one-click?t=x");
    await t.send({ from: "TeamBalance Pro <noreply@mail.teambalancepro.com>", to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>", headers });
    expect(calls[0].body.headers).toEqual(headers);
    await expect(t.send({ from: "f@x.test", to: "a@example.com", subject: "s", text: "t", html: "h", headers: { Bcc: "x@y.test" } })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("the in-memory test transport enforces the same contract", async () => {
    const m = createMemoryTransport();
    await expect(m.send({ from: "f@x.test", to: "a@example.com", subject: "s", text: "t", html: "h", headers: { "X-Evil": "1" } })).rejects.toThrow();
    expect(m.sent).toHaveLength(0);
  });
  it("account / password emails carry no unsubscribe headers (they are never suppressible)", () => {
    const idx = fs.readFileSync(path.join(process.cwd(), "src/lib/email/index.ts"), "utf8");
    expect(idx).not.toMatch(/List-Unsubscribe|suppressedFor|emailSuppression/);
  });
});

describe("maskEmail (shared)", () => {
  it("masks the local part and keeps the full domain", () => {
    expect(maskEmail("Parent.Of.Ava@Sub.Example.co.uk")).toBe("P•••@Sub.Example.co.uk");
  });
});
