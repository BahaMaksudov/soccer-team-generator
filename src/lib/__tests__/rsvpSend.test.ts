import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { rsvpTransport, setRsvpTransportForTests, sanitizeSendError, RsvpDeliveryDisabledError } from "@/lib/rsvpSend";
import { buildRsvpInvitationEmail, headerSafe } from "@/lib/email/templates";
import { EmailDeliveryError, testOutbox } from "@/lib/email/transport";
import { EmailConfigError } from "@/lib/email/config";

/** M13B P4 — the sending engine's server-side delivery lock, error sanitizing, the invitation email, and source guards. */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("delivery is test-outbox-only, enforced on the server", () => {
  it("outside NODE_ENV=test the transport and the test override both refuse", () => {
    for (const NODE_ENV of ["production", "development", undefined, "preview"]) {
      expect(() => rsvpTransport({ NODE_ENV, RESEND_API_KEY: "re_x", EMAIL_TRANSPORT: "resend" }), String(NODE_ENV)).toThrow(RsvpDeliveryDisabledError);
      expect(() => setRsvpTransportForTests(testOutbox, { NODE_ENV })).toThrow(RsvpDeliveryDisabledError);
    }
  });
  it("under NODE_ENV=test it is the in-memory test outbox", () => {
    expect(rsvpTransport({ NODE_ENV: "test" })).toBe(testOutbox);
  });
  it("the engine never references the real transport, fetch or Resend", () => {
    const src = read("src/lib/rsvpSend.ts");
    expect(src).not.toMatch(/createResendTransport|getEmailTransport|RESEND_ENDPOINT|RESEND_API_KEY|fetch\(|from "@\/lib\/email"/);
    expect(src).not.toMatch(/console\.(log|info|warn|error)/); // nothing logged (no addresses, no tokens)
  });
  it("no route, page or server action imports the engine (no callable delivery endpoint)", () => {
    const hits = execSync("grep -rlE \"rsvpSend\" src/app src/middleware.ts || true", { encoding: "utf8" }).trim();
    expect(hits).toBe("");
  });
  it("the preview card's Send button is still disabled with no handler", () => {
    const card = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/RsvpPreviewCard.tsx");
    const button = card.slice(card.indexOf("<Button"), card.indexOf("</Button>"));
    expect(button).toContain("disabled");
    expect(button).not.toContain("onClick");
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

describe("RSVP invitation email", () => {
  const base = {
    to: "pat@example.com",
    playerName: "Ava <b>Lee</b>",
    organizationName: "Club & Co",
    title: "Mondays",
    when: "on Wednesday, June 3 at 9:00 PM",
    venue: "Field 2",
    deadline: "Wednesday, June 3 at 6:00 PM EDT",
    answerUrl: "https://teambalancepro.com/attendance/p/tok",
    unsubscribeUrl: "https://teambalancepro.com/unsubscribe#unsub",
  };
  it("player wording, answer link, unsubscribe link; HTML escaped", () => {
    const e = buildRsvpInvitationEmail({ ...base, recipientType: "PLAYER" });
    expect(e.subject).toBe("Are you playing? Mondays — on Wednesday, June 3 at 9:00 PM");
    expect(e.text).toContain("Hi Ava <b>Lee</b>,");
    expect(e.text).toContain("Answer: https://teambalancepro.com/attendance/p/tok");
    expect(e.text).toContain("Stop match invitation emails from Club & Co: https://teambalancepro.com/unsubscribe#unsub");
    expect(e.html).not.toContain("<b>Lee</b>");
    expect(e.html).toContain("Ava &lt;b&gt;Lee&lt;/b&gt;");
    expect(e.html).toContain('href="https://teambalancepro.com/unsubscribe#unsub"');
    expect(e.html).toContain("Answer now");
    expect(e.html.trim().endsWith("</div>")).toBe(true);
  });
  it("guardian wording names the player and addresses the guardian", () => {
    const e = buildRsvpInvitationEmail({ ...base, playerName: "Ava Lee", recipientType: "GUARDIAN" });
    expect(e.subject).toMatch(/^Is Ava Lee playing\?/);
    expect(e.text).toContain("parent / guardian contact for Ava Lee");
    expect(e.text).not.toContain("Hi Ava Lee");
  });
  it("subject is header-safe (no CR/LF injection, bounded)", () => {
    const e = buildRsvpInvitationEmail({ ...base, recipientType: "PLAYER", title: "Evil\r\nBcc: x@y.test" });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(headerSafe("a\u0000b\nc" + "x".repeat(300)).length).toBe(200);
  });
});
