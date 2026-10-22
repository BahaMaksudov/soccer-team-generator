import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { rsvpTransport, setRsvpTransportForTests, sanitizeSendError, RsvpDeliveryDisabledError } from "@/lib/rsvpSend";
import { rsvpDeliveryMode, isLocalTestDatabaseUrl } from "@/lib/rsvpDeliveryMode";
import { buildRsvpInvitationEmail, headerSafe } from "@/lib/email/templates";
import { EmailDeliveryError, testOutbox } from "@/lib/email/transport";
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

describe("source guards (no real delivery path)", () => {
  it("the engine never references the real transport, fetch or Resend, and logs nothing", () => {
    for (const f of ["src/lib/rsvpSend.ts", "src/lib/rsvpDeliveryMode.ts", "src/lib/rsvpStatus.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/createResendTransport|getEmailTransport|RESEND_ENDPOINT|RESEND_API_KEY|fetch\(|from "@\/lib\/email"/);
      expect(src, f).not.toMatch(/console\.(log|info|warn)/);
    }
  });
  it("only the send route and the cron continuation import the engine, and both check the delivery gate first", () => {
    const hits = execSync(`grep -rlE "@/lib/rsvpSend\\"" src/app src/middleware.ts || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
    expect(hits).toEqual([CRON_ROUTE, SEND_ROUTE].sort());
    const route = read(SEND_ROUTE);
    expect(route).toMatch(/if \(rsvpDeliveryMode\(\) !== "test-outbox"\) return refuse\("DELIVERY_DISABLED"\);/);
    expect(route.indexOf('rsvpDeliveryMode() !== "test-outbox"')).toBeLessThan(route.indexOf("schema.safeParse"));
    expect(route).toContain("requireJsonRequest(req)");
    expect(route).toContain("isSameOrigin(req)");
    expect(route).toContain("managersOnlyResponse(context)");
    expect(route).toMatch(/\.strict\(\)/);
    expect(route).not.toMatch(/\b(to|email|subject|html|body)\s*:\s*z\./); // no addresses or content from the client
    const cron = read(CRON_ROUTE);
    expect(cron).toMatch(/if \(rsvpDeliveryMode\(\) !== "test-outbox"\) return \{ ok: true, counts: \{ disabled: true \} \};/);
  });
  it("the card's Send button is shown disabled unless the server says sending is available, and posts a request key + attestation", () => {
    const card = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/RsvpPreviewCard.tsx");
    expect(card).toContain("const available = Boolean(preview?.sending.available);");
    expect(card).toMatch(/!available \? \(\s*<div>\s*<Button type="button" disabled aria-disabled="true"/);
    expect(card).toMatch(/action: "send", kind, requestKey: requestKey\.current, expectedCount: willSend, attested: true/);
    expect(card).toContain("disabled={!attested || busy}");
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
