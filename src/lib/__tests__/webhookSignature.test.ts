import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { verifyWebhook, signWebhookForTests, webhookHeaders, WEBHOOK_TOLERANCE_SECONDS } from "@/lib/webhookSignature";

/** M13B P6 — Svix webhook signature verification (Resend), checked against Svix's published test vector. */
// docs.svix.com/receiving/verifying-payloads/how-manual — "Test Example"
const VECTOR = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  payload: '{"event_type":"ping","data":{"success":true}}',
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: "1731705121",
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
};
const AT = new Date(Number(VECTOR.timestamp) * 1000);
const H = { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature };

describe("verifyWebhook", () => {
  it("accepts the Svix documentation's test vector", () => {
    expect(verifyWebhook(VECTOR.payload, H, VECTOR.secret, AT)).toBe("ok");
    expect(signWebhookForTests(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.payload)).toBe(VECTOR.signature);
  });
  it("any one of several space-delimited v1 signatures may match; other versions are ignored", () => {
    expect(verifyWebhook(VECTOR.payload, { ...H, signature: `v1,AAAA v2,${VECTOR.signature.slice(3)} ${VECTOR.signature}` }, VECTOR.secret, AT)).toBe("ok");
    expect(verifyWebhook(VECTOR.payload, { ...H, signature: `v2,${VECTOR.signature.slice(3)}` }, VECTOR.secret, AT)).toBe("invalid");
  });
  it("rejects a modified body, id or timestamp, and a wrong secret", () => {
    expect(verifyWebhook(VECTOR.payload.replace("true", "false"), H, VECTOR.secret, AT)).toBe("invalid");
    expect(verifyWebhook(`${VECTOR.payload} `, H, VECTOR.secret, AT)).toBe("invalid"); // the RAW body is signed
    expect(verifyWebhook(VECTOR.payload, { ...H, id: "msg_other" }, VECTOR.secret, AT)).toBe("invalid");
    expect(verifyWebhook(VECTOR.payload, { ...H, timestamp: "1731705122" }, VECTOR.secret, AT)).toBe("invalid");
    expect(verifyWebhook(VECTOR.payload, H, "whsec_" + Buffer.alloc(24, 7).toString("base64"), AT)).toBe("invalid");
    expect(verifyWebhook(VECTOR.payload, { ...H, signature: "v1,not-base64!!" }, VECTOR.secret, AT)).toBe("invalid");
  });
  it("replay window: outside ±5 minutes is stale (old or future)", () => {
    const at = (s: number) => new Date(AT.getTime() + s * 1000);
    expect(verifyWebhook(VECTOR.payload, H, VECTOR.secret, at(WEBHOOK_TOLERANCE_SECONDS))).toBe("ok");
    expect(verifyWebhook(VECTOR.payload, H, VECTOR.secret, at(WEBHOOK_TOLERANCE_SECONDS + 1))).toBe("stale");
    expect(verifyWebhook(VECTOR.payload, H, VECTOR.secret, at(-WEBHOOK_TOLERANCE_SECONDS - 1))).toBe("stale");
    expect(verifyWebhook(VECTOR.payload, { ...H, timestamp: "17317e5121" }, VECTOR.secret, AT)).toBe("invalid");
  });
  it("fails closed without a (well-formed) secret or headers", () => {
    for (const secret of [undefined, "", "plJ3nmyCDGBKInavdOK15jsl", "whsec_", "whsec_AAAA"]) expect(verifyWebhook(VECTOR.payload, H, secret, AT), String(secret)).toBe("not_configured");
    expect(verifyWebhook(VECTOR.payload, { ...H, signature: null }, VECTOR.secret, AT)).toBe("missing_headers");
    expect(verifyWebhook(VECTOR.payload, { ...H, id: null }, VECTOR.secret, AT)).toBe("missing_headers");
  });
  it("reads svix-* headers (Resend) and webhook-* (Standard Webhooks)", () => {
    expect(webhookHeaders(new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x" }))).toEqual({ id: "a", timestamp: "1", signature: "v1,x" });
    expect(webhookHeaders(new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" }))).toEqual({ id: "b", timestamp: "2", signature: "v1,y" });
  });
});

describe("unsubscribe / webhook source guards", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("no unsubscribe or webhook route logs the request URL, a token or an address; GET never mutates", () => {
    for (const f of ["src/app/api/email/unsubscribe/route.ts", "src/app/api/email/unsubscribe/preview/route.ts", "src/app/api/email/unsubscribe/one-click/route.ts", "src/app/api/email/webhooks/resend/route.ts", "src/lib/emailSuppression.ts", "src/lib/emailWebhook.ts"]) {
      const src = read(f);
      // A log line may only be a fixed string: no interpolation and no extra arguments (URL, token, address, payload).
      expect(src, f).not.toMatch(/console\.(log|info|warn|error)\([^)]*(\$\{|,\s*[A-Za-z])/);
      expect(src, f).not.toMatch(/export async function GET/);
    }
  });
  it("the unsubscribe page removes the token from the address bar once read", () => {
    expect(read("src/app/unsubscribe/UnsubscribeView.tsx")).toContain('window.history.replaceState(null, "", "/unsubscribe")');
  });
  it("the webhook verifies the raw body before parsing it", () => {
    const route = read("src/app/api/email/webhooks/resend/route.ts");
    expect(route.indexOf("verifyWebhook(")).toBeGreaterThan(0);
    expect(route.indexOf("verifyWebhook(")).toBeLessThan(route.indexOf("JSON.parse("));
    expect(route).toContain("await readCapped(req, MAX_BODY_BYTES)"); // P7: raw bytes, capped while streaming
  });
});
