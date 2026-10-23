import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { parseContactEmail, normalizeEmail } from "@/lib/emailAddress";
import { resolveRecipient } from "@/lib/playerContact";

/** M13B P1 — contact email validation, recipient resolution, and a source-level privacy guard. */
describe("parseContactEmail", () => {
  it("normalizes like account emails (trim + lowercase); keeps dots and +tags", () => {
    expect(parseContactEmail("  Pat.Smith+Soccer@Example.COM ")).toEqual({ ok: true, email: "pat.smith+soccer@example.com" });
    expect(parseContactEmail("Pat.Smith+Soccer@Example.COM")).toEqual({ ok: true, email: normalizeEmail("Pat.Smith+Soccer@Example.COM") });
  });
  it("blank / null clears", () => {
    for (const v of [null, undefined, "", "   "]) expect(parseContactEmail(v)).toEqual({ ok: true, email: null });
  });
  it("rejects invalid syntax, wrong types and overlong values", () => {
    for (const v of ["nope", "a@", "@b.com", "a b@c.com", "a@b", "a@@b.com", 42, {}, [], true]) expect(parseContactEmail(v).ok, String(v)).toBe(false);
    expect(parseContactEmail(`${"a".repeat(65)}@example.com`).ok).toBe(false); // local part > 64
    expect(parseContactEmail(`a@${"b".repeat(250)}.com`)).toEqual({ ok: false, error: "Email is too long." });
  });
  it("rejects CR/LF and other control characters anywhere — even at the edges where trimming would hide them", () => {
    for (const v of ["a@b.com\r\nBcc: x@y.com", "a@b.com\n", "\ra@b.com", "a@b.com\u0000", "a\tb@c.com", "a@b.com ", "a@b.com\u0085", "a@b.com\u007f"]) {
      expect(parseContactEmail(v).ok, JSON.stringify(v)).toBe(false);
    }
  });
});

describe("resolveRecipient (no sending)", () => {
  const verified = { email: "Account@Example.com", emailVerifiedAt: new Date("2026-01-01") };
  const AUTH = new Date("2026-10-01T00:00:00Z");
  it("P6: a valid contact nobody confirmed is UNCONFIRMED_CONTACT — never emailed, never falls back to the account", () => {
    expect(resolveRecipient({ contactEmail: "kid.parent@example.com", contactEmailType: "GUARDIAN", contactAuthorizedAt: null, user: verified })).toEqual({ kind: "UNCONFIRMED_CONTACT", contactType: "GUARDIAN" });
    expect(resolveRecipient({ contactEmail: "me@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: null, user: null })).toEqual({ kind: "UNCONFIRMED_CONTACT", contactType: "PLAYER" });
  });
  it("1. the organizer contact wins over the account, keeping PLAYER / GUARDIAN", () => {
    expect(resolveRecipient({ contactEmail: "kid.parent@example.com", contactEmailType: "GUARDIAN", contactAuthorizedAt: AUTH, user: verified })).toEqual({ kind: "CONTACT", email: "kid.parent@example.com", contactType: "GUARDIAN" });
    expect(resolveRecipient({ contactEmail: "me@example.com", contactEmailType: "PLAYER", contactAuthorizedAt: AUTH, user: null })).toEqual({ kind: "CONTACT", email: "me@example.com", contactType: "PLAYER" });
  });
  it("2. otherwise a VERIFIED linked account's email (normalized)", () => {
    expect(resolveRecipient({ contactEmail: null, contactEmailType: null, contactAuthorizedAt: null, user: verified })).toEqual({ kind: "ACCOUNT", email: "account@example.com" });
  });
  it("an unverified account is never used", () => {
    expect(resolveRecipient({ contactEmail: null, contactEmailType: null, contactAuthorizedAt: null, user: { email: "x@example.com", emailVerifiedAt: null } })).toEqual({ kind: "NO_EMAIL" });
  });
  it("3. nothing → NO_EMAIL", () => {
    expect(resolveRecipient({ contactEmail: null, contactEmailType: null, contactAuthorizedAt: null, user: null })).toEqual({ kind: "NO_EMAIL" });
  });
  it("a stored contact that no longer validates (or lacks its type) is INVALID_CONTACT — never falls through to the account", () => {
    expect(resolveRecipient({ contactEmail: "broken", contactEmailType: "GUARDIAN", contactAuthorizedAt: AUTH, user: verified })).toEqual({ kind: "INVALID_CONTACT" });
    expect(resolveRecipient({ contactEmail: "ok@example.com", contactEmailType: null, contactAuthorizedAt: AUTH, user: verified })).toEqual({ kind: "INVALID_CONTACT" });
  });
});

describe("privacy guard: contact fields are touched only by the approved files", () => {
  const ALLOWED = new Set([
    "src/lib/playerContact.ts",
    "src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/[id]/contact/route.ts",
    "src/app/admin/o/[organizationSlug]/g/[groupSlug]/PlayerContactCell.tsx",
    // M13B P6 — the sending engine re-resolves the recipient at send time (server-only, never logged or returned).
    "src/lib/rsvpSend.ts",
    // M13B P7 — support-only privacy erasure clears a requested address from player contacts (counts only, never logged).
    "src/lib/rsvpRetention.ts",
  ]);
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  it("no other source file reads or writes contactEmail / contactEmailType", () => {
    const offenders = walk(path.join(process.cwd(), "src"))
      .map((f) => path.relative(process.cwd(), f))
      .filter((f) => /\.(tsx?)$/.test(f) && !/__tests__|\.test\.tsx?$|\.itest\.ts$/.test(f) && !ALLOWED.has(f))
      .filter((f) => /contactEmail/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
