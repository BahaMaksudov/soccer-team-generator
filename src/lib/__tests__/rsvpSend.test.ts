import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { rsvpTransport, setRsvpTransportForTests, sanitizeSendError, RsvpDeliveryDisabledError, classifyRsvpSendError, RSVP_LIVE_MIN_INTERVAL_MS } from "@/lib/rsvpSend";
import { rsvpDeliveryMode, isLocalTestDatabaseUrl, rsvpDeliveryAllowedFor, pilotOrganizations, rsvpSenderValid, RSVP_PILOT_LIMITS } from "@/lib/rsvpDeliveryMode";
import { buildRsvpInvitationEmail, headerSafe } from "@/lib/email/templates";
import { EmailDeliveryError, parseRetryAfter, testOutbox } from "@/lib/email/transport";
import { EmailConfigError } from "@/lib/email/config";
import { choiceFromSearch } from "@/lib/rsvpChoice";

/** M13B P4/P5 — the sending engine's server-side delivery gate, error sanitizing, the invitation email, and source guards. */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const LOCAL_TEST_DB = "postgresql://me@localhost:5432/soccer_team_generator_test";
const SEND_ROUTE = "src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-send/route.ts";
const CRON_ROUTE = "src/app/api/cron/automation/route.ts";

describe("delivery mode (server-side gate)", () => {
  it("Production and Preview builds are always disabled, whatever the email configuration", () => {
    for (const env of [
      { NODE_ENV: "production", VERCEL_ENV: "production", EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x", RSVP_EMAIL_LOCAL_TEST_OUTBOX: "1", DATABASE_URL: LOCAL_TEST_DB },
      { NODE_ENV: "production", VERCEL_ENV: "preview", VERCEL: "1", RSVP_EMAIL_LOCAL_TEST_OUTBOX: "1", DATABASE_URL: LOCAL_TEST_DB },
      { NODE_ENV: "production", RSVP_EMAIL_LOCAL_TEST_OUTBOX: "1", DATABASE_URL: LOCAL_TEST_DB }, // local `next start`
      {},
    ]) {
      expect(rsvpDeliveryMode(env), JSON.stringify(env)).toBe("disabled");
      expect(() => rsvpTransport(env)).toThrow(RsvpDeliveryDisabledError);
    }
  });
  it("development needs the explicit flag, no Vercel, AND a local test database", () => {
    const base = { NODE_ENV: "development", RSVP_EMAIL_LOCAL_TEST_OUTBOX: "1", DATABASE_URL: LOCAL_TEST_DB };
    expect(rsvpDeliveryMode(base)).toBe("test-outbox");
    expect(rsvpDeliveryMode({ ...base, RSVP_EMAIL_LOCAL_TEST_OUTBOX: undefined })).toBe("disabled");
    expect(rsvpDeliveryMode({ ...base, RSVP_EMAIL_LOCAL_TEST_OUTBOX: "true" })).toBe("disabled");
    expect(rsvpDeliveryMode({ ...base, VERCEL: "1" })).toBe("disabled");
    expect(rsvpDeliveryMode({ ...base, VERCEL_ENV: "development" })).toBe("disabled");
    expect(rsvpDeliveryMode({ ...base, DATABASE_URL: "postgresql://u:p@ep-x.neon.tech/neondb" })).toBe("disabled");
    expect(rsvpDeliveryMode({ ...base, DATABASE_URL: "postgresql://u@localhost:5432/soccer_prod" })).toBe("disabled");
    expect(rsvpTransport(base)).toBe(testOutbox);
  });
  it("only a localhost database named *test* counts as a local test database", () => {
    expect(isLocalTestDatabaseUrl(LOCAL_TEST_DB)).toBe(true);
    expect(isLocalTestDatabaseUrl("postgres://x@127.0.0.1/app_test")).toBe(true);
    expect(isLocalTestDatabaseUrl("postgresql://x@test.example.com/app_test")).toBe(false);
    expect(isLocalTestDatabaseUrl("postgresql://x@localhost.evil.com/app_test")).toBe(false);
    expect(isLocalTestDatabaseUrl("mysql://x@localhost/app_test")).toBe(false);
    expect(isLocalTestDatabaseUrl("not a url")).toBe(false);
    expect(isLocalTestDatabaseUrl(undefined)).toBe(false);
  });
  it("NODE_ENV=test is the in-memory outbox; the test override is refused anywhere else", () => {
    expect(rsvpTransport({ NODE_ENV: "test" })).toBe(testOutbox);
    for (const NODE_ENV of ["production", "development", undefined]) expect(() => setRsvpTransportForTests(testOutbox, { NODE_ENV })).toThrow(RsvpDeliveryDisabledError);
  });
});

describe("P8A live pilot mode (default off)", () => {
  const ORG = "cm3pilotorg00000000000001";
  const LIVE = { NODE_ENV: "production", VERCEL_ENV: "production", RSVP_EMAIL_DELIVERY: "live-pilot", RSVP_EMAIL_PILOT_ORGS: ORG, RESEND_API_KEY: "re_fake_key", EMAIL_FROM: "TeamBalance Pro <noreply@mail.teambalancepro.com>" };
  it("live only when EVERY condition holds", () => {
    expect(rsvpDeliveryMode(LIVE)).toBe("live");
    expect(rsvpTransport(LIVE).name).toBe("resend");
  });
  it("no existing setting can switch it on; every missing or wrong condition is disabled", () => {
    const off: Array<Record<string, string | undefined>> = [
      { ...LIVE, RSVP_EMAIL_DELIVERY: undefined }, // only the pre-existing Resend settings
      { ...LIVE, RSVP_EMAIL_DELIVERY: "true" },
      { ...LIVE, RSVP_EMAIL_DELIVERY: "1" },
      { ...LIVE, RSVP_EMAIL_DELIVERY: "live" },
      { ...LIVE, RSVP_EMAIL_DELIVERY: "LIVE-PILOT" },
      { ...LIVE, VERCEL_ENV: "preview" }, // Preview
      { ...LIVE, VERCEL_ENV: undefined }, // local `next start`
      { ...LIVE, NODE_ENV: "development" }, // dev
      { ...LIVE, RSVP_EMAIL_PILOT_ORGS: undefined },
      { ...LIVE, RSVP_EMAIL_PILOT_ORGS: "" },
      { ...LIVE, RSVP_EMAIL_PILOT_ORGS: `${ORG},not valid` }, // one bad entry disables all
      { ...LIVE, RESEND_API_KEY: undefined },
      { ...LIVE, RESEND_API_KEY: "  " },
      { ...LIVE, EMAIL_FROM: "noreply@mail.teambalancepro.com" }, // no display name
      { ...LIVE, EMAIL_FROM: "TeamBalance Pro <noreply@teambalancepro.com>" }, // not the RSVP sender domain
      { ...LIVE, EMAIL_FROM: "TeamBalance Pro <noreply@mail.teambalancepro.com.evil.io>" },
      { ...LIVE, EMAIL_FROM: "Evil\r\nBcc: x <noreply@mail.teambalancepro.com>" },
      { NODE_ENV: "production", VERCEL_ENV: "production", EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x", EMAIL_FROM: LIVE.EMAIL_FROM },
    ];
    for (const env of off) {
      expect(rsvpDeliveryMode(env), JSON.stringify(env)).toBe("disabled");
      expect(() => rsvpTransport(env)).toThrow(RsvpDeliveryDisabledError);
      expect(rsvpDeliveryAllowedFor(ORG, env)).toBe(false);
    }
    // In tests the mode is always the outbox, never live — even with every live setting.
    expect(rsvpDeliveryMode({ ...LIVE, NODE_ENV: "test" })).toBe("test-outbox");
  });
  it("the allowlist: only listed organizations, at most 10, cuid-shaped ids", () => {
    expect(rsvpDeliveryAllowedFor(ORG, LIVE)).toBe(true);
    expect(rsvpDeliveryAllowedFor("cm3otherorg0000000000000001", LIVE)).toBe(false);
    expect(pilotOrganizations({ RSVP_EMAIL_PILOT_ORGS: ` ${ORG} , cm3pilotorg00000000000002 ` })).toEqual(new Set([ORG, "cm3pilotorg00000000000002"]));
    expect(pilotOrganizations({ RSVP_EMAIL_PILOT_ORGS: Array.from({ length: 11 }, (_, i) => `cm3pilotorg0000000000000${String(i).padStart(2, "0")}`).join(",") })).toBeNull();
    expect(pilotOrganizations({ RSVP_EMAIL_PILOT_ORGS: "*" })).toBeNull();
  });
  it("the sender must be a display name on the RSVP sending domain", () => {
    expect(rsvpSenderValid("TeamBalance Pro <noreply@mail.teambalancepro.com>")).toBe(true);
    expect(rsvpSenderValid("TeamBalance Pro <noreply@MAIL.teambalancepro.com>")).toBe(true);
    expect(rsvpSenderValid(undefined)).toBe(false);
  });
  it("pilot limits are stricter than any plan and fixed in code", () => {
    expect(RSVP_PILOT_LIMITS).toEqual({ perOrganizationDay: 20, perOrganizationMonth: 100, allOrganizationsDay: 100 });
    expect(read("src/lib/rsvpDeliveryMode.ts")).not.toMatch(/env\.[A-Z_]*LIMIT/);
  });
  it("a test transport override is never used in live mode", () => {
    expect(() => setRsvpTransportForTests(testOutbox, LIVE)).toThrow(RsvpDeliveryDisabledError);
  });
});

describe("source guards (no real delivery path)", () => {
  it("the engine reaches Resend only through the live branch of rsvpTransport; never the account-email transport; logs nothing", () => {
    for (const f of ["src/lib/rsvpSend.ts", "src/lib/rsvpDeliveryMode.ts", "src/lib/rsvpStatus.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/getEmailTransport|setEmailTransportForTests|RESEND_ENDPOINT|fetch\(|from "@\/lib\/email"/);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error)/);
    }
    const engine = read("src/lib/rsvpSend.ts");
    expect(engine.match(/createRsvpResendTransport\(/g)).toHaveLength(1);
    expect(engine).toMatch(/if \(mode === "live"\) return createRsvpResendTransport\(/);
    expect(engine).not.toMatch(/RESEND_API_KEY|createResendTransport\(/); // the key is read only in src/lib/email/transport.ts
  });
  it("account / security email code is untouched by RSVP delivery", () => {
    const idx = read("src/lib/email/index.ts");
    expect(idx).not.toMatch(/rsvp|RSVP_EMAIL|pilot/i);
  });
  it("only the send route and the cron continuation import the engine, and both check the delivery gate first", () => {
    const hits = execSync(`grep -rlE "@/lib/rsvpSend\\"" src/app src/middleware.ts || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
    expect(hits).toEqual([CRON_ROUTE, SEND_ROUTE].sort());
    const route = read(SEND_ROUTE);
    expect(route).toMatch(/if \(!rsvpDeliveryAllowedFor\(context\.organization\.id\)\) return refuse\("DELIVERY_DISABLED"\);/);
    expect(route.indexOf("rsvpDeliveryAllowedFor(context.organization.id)")).toBeLessThan(route.indexOf("schema.safeParse"));
    expect(route).toContain("requireJsonRequest(req)");
    expect(route).toContain("isSameOrigin(req)");
    expect(route).toContain("managersOnlyResponse(context)");
    expect(route).toMatch(/\.strict\(\)/);
    expect(route).not.toMatch(/\b(to|email|subject|html|body)\s*:\s*z\./); // no addresses or content from the client
    const cron = read(CRON_ROUTE);
    expect(cron).toMatch(/if \(rsvpDeliveryMode\(\) === "disabled"\) return \{ ok: true, counts: \{ disabled: true \} \};/);
  });
  it("the card's Send button is shown disabled unless the server says sending is available, and posts a request key + attestation", () => {
    const card = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/RsvpPreviewCard.tsx");
    expect(card).toContain("const available = Boolean(preview?.sending.available);");
    expect(card).toMatch(/!available \? \(\s*<div>\s*<Button type="button" disabled aria-disabled="true"/);
    expect(card).toMatch(/action: "send", kind, requestKey: requestKey\.current, expectedCount: willSend, attested: true/);
    expect(card).toContain("disabled={!attested || busy}");
  });
});

describe("P8A.1 provider outcome classification (Resend errors reference)", () => {
  const http = (s: number, retry: number | null = null) => classifyRsvpSendError(new EmailDeliveryError("http", s, retry));
  it("definite refusals are FAILED (released); configuration refusals also stop the run", () => {
    for (const s of [400, 422, 451]) expect(http(s), String(s)).toEqual({ outcome: "FAILED", stop: false, backoffSeconds: null });
    for (const s of [401, 403, 404, 405]) expect(http(s), String(s)).toEqual({ outcome: "FAILED", stop: true, backoffSeconds: null });
    expect(classifyRsvpSendError(new EmailConfigError("EMAIL_FROM is not set."))).toEqual({ outcome: "FAILED", stop: true, backoffSeconds: null });
  });
  it("anything that may have been accepted is UNCERTAIN; provider trouble stops the run and backs off", () => {
    expect(http(409)).toEqual({ outcome: "UNCERTAIN", stop: false, backoffSeconds: null });
    for (const s of [500, 502, 503, 504]) expect(http(s), String(s)).toEqual({ outcome: "UNCERTAIN", stop: true, backoffSeconds: 60 });
    expect(classifyRsvpSendError(new EmailDeliveryError("timeout"))).toEqual({ outcome: "UNCERTAIN", stop: true, backoffSeconds: 30 });
    expect(classifyRsvpSendError(new EmailDeliveryError("network"))).toEqual({ outcome: "UNCERTAIN", stop: true, backoffSeconds: 30 });
    expect(classifyRsvpSendError(new Error("weird"))).toEqual({ outcome: "UNCERTAIN", stop: false, backoffSeconds: null });
  });
  it("429 is RATE_LIMITED: requeued (not failed, not released), honoring Retry-After or 60 s", () => {
    expect(http(429, 7)).toEqual({ outcome: "RATE_LIMITED", stop: true, backoffSeconds: 7 });
    expect(http(429)).toEqual({ outcome: "RATE_LIMITED", stop: true, backoffSeconds: 60 });
    expect(sanitizeSendError(new EmailDeliveryError("http", 429, 7))).toBe("RATE_LIMITED");
  });
  it("Retry-After: whole seconds (or ratelimit-reset), capped at an hour; anything else ignored", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "5" }))).toBe(5);
    expect(parseRetryAfter(new Headers({ "ratelimit-reset": "12" }))).toBe(12);
    expect(parseRetryAfter(new Headers({ "retry-after": "999999" }))).toBe(3600);
    for (const v of ["", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "5s"]) expect(parseRetryAfter(new Headers({ "retry-after": v })), v).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
  it("live pacing keeps the total well under Resend's documented 10 requests / second per team", () => {
    expect(1000 / RSVP_LIVE_MIN_INTERVAL_MS).toBeLessThanOrEqual(4);
  });
});

describe("sanitizeSendError", () => {
  it("stores a category, never a message, address or token", () => {
    expect(sanitizeSendError(new EmailDeliveryError("http", 422))).toBe("HTTP_422");
    expect(sanitizeSendError(new EmailDeliveryError("timeout"))).toBe("TIMEOUT");
    expect(sanitizeSendError(new EmailDeliveryError("network"))).toBe("NETWORK");
    expect(sanitizeSendError(new EmailConfigError("EMAIL_FROM is not set."))).toBe("CONFIG");
    expect(sanitizeSendError(new Error("boom for pat@example.com token abc"))).toBe("UNEXPECTED");
    expect(sanitizeSendError("x")).toBe("UNEXPECTED");
  });
});

describe("RSVP invitation email (HTML + plain text)", () => {
  const U = "https://teambalancepro.com/attend";
  const base = {
    to: "pat@example.com",
    playerName: "Ava <b>Lee</b>",
    organizationName: "Club & Co",
    title: "Mondays",
    when: "Wednesday, June 3 at 9:00 PM",
    venue: "Field 2",
    deadline: "Wednesday, June 3 at 6:00 PM EDT",
    answerUrls: { open: `${U}#tok`, yes: `${U}?c=yes#tok`, maybe: `${U}?c=maybe#tok`, no: `${U}?c=no#tok` },
    unsubscribeUrl: "https://teambalancepro.com/unsubscribe#unsub",
  };
  it("branding, match details, Yes / Maybe / No links, deadline, unsubscribe; HTML escaped", () => {
    const e = buildRsvpInvitationEmail({ ...base, recipientType: "PLAYER" });
    expect(e.html).toContain("TeamBalance Pro");
    for (const s of ["Mondays — Wednesday, June 3 at 9:00 PM", "Where: Field 2", "Please answer by Wednesday, June 3 at 6:00 PM EDT"]) {
      expect(e.text).toContain(s);
      expect(e.html).toContain(s);
    }
    for (const [label, url] of [["Yes, playing", base.answerUrls.yes], ["Maybe", base.answerUrls.maybe], ["No, not playing", base.answerUrls.no]]) {
      expect(e.text).toContain(`${label}: ${url}`);
      expect(e.html).toContain(`href="${url}"`);
    }
    expect(e.text).toContain("saved only after you tap Confirm");
    expect(e.text).toContain("Stop match invitation emails from Club & Co: https://teambalancepro.com/unsubscribe#unsub");
    expect(e.html).toContain('href="https://teambalancepro.com/unsubscribe#unsub"');
    expect(e.text).toContain("Hi Ava <b>Lee</b>,");
    expect(e.html).not.toContain("<b>Lee</b>");
    expect(e.html).toContain("Ava &lt;b&gt;Lee&lt;/b&gt;");
    expect(e.html).toContain("Club &amp; Co");
    expect(e.html).toMatch(/max-width:560px/); // single responsive column
  });
  it("the subject carries no personal details (no player name, no address)", () => {
    for (const recipientType of ["PLAYER", "GUARDIAN", "ACCOUNT"] as const) {
      const e = buildRsvpInvitationEmail({ ...base, playerName: "Ava Lee", recipientType });
      expect(e.subject).toBe("RSVP: Mondays — Wednesday, June 3 at 9:00 PM");
      expect(e.subject).not.toMatch(/Ava|Lee|pat@/);
    }
  });
  it("guardian wording: a neutral greeting, names the player, asks about the player", () => {
    const e = buildRsvpInvitationEmail({ ...base, playerName: "Ava Lee", recipientType: "GUARDIAN" });
    expect(e.text).toMatch(/^Is Ava Lee playing\?\n\nHello,\nYou're receiving this as the parent \/ guardian contact for Ava Lee\./);
    expect(e.text).not.toContain("Hi Ava Lee");
    expect(e.text).toContain("for Ava Lee's match invitations");
  });
  it("no venue / deadline: those lines are omitted or neutral", () => {
    const e = buildRsvpInvitationEmail({ ...base, recipientType: "PLAYER", venue: null, deadline: null });
    expect(e.text).not.toContain("Where:");
    expect(e.text).toContain("You can change the answer until attendance closes.");
  });
  it("subject is header-safe (no CR/LF injection, bounded)", () => {
    const e = buildRsvpInvitationEmail({ ...base, recipientType: "PLAYER", title: "Evil\r\nBcc: x@y.test" });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(headerSafe("a\u0000b\nc" + "x".repeat(300)).length).toBe(200);
  });
});

describe("email choice links only pre-select", () => {
  it("maps yes / maybe / no; ignores anything else", () => {
    expect(choiceFromSearch("?c=yes")).toBe("PLAYING");
    expect(choiceFromSearch("?c=maybe")).toBe("MAYBE");
    expect(choiceFromSearch("?c=no")).toBe("NOT_PLAYING");
    for (const s of ["", "?c=YES", "?c=constructor", "?c=__proto__", "?x=yes", "?c="]) expect(choiceFromSearch(s), s).toBeNull();
  });
  it("the page saves only from an explicit click (Confirm or an answer button), never on load", () => {
    const page = read("src/app/attend/PersonalAttendancePage.tsx");
    const load = page.slice(page.indexOf("useEffect(() => {\n    const t = window.location.hash"), page.indexOf("useEffect(() => {\n    const id = window.setInterval"));
    expect(load).toContain("setPending(chosen)");
    expect(load).not.toMatch(/answer\(|\/api\/attend\/answer/);
    expect(page.match(/answer\(/g)?.length).toBe(3); // the definition, Confirm, and the option buttons
    expect(page).toContain("onClick={() => answer(pending)}");
  });
});
