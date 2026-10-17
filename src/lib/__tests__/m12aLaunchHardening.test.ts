import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AppError from "@/app/error";
import GlobalError from "@/app/global-error";
import { supportEmail } from "@/lib/support";

/** M12-A — secrets stay server-side; error pages never leak details; support contact never invented. */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/test\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
afterEach(() => vi.unstubAllEnvs());

describe("Google OAuth secret handling", () => {
  it("GOOGLE_CLIENT_SECRET is read only by src/lib/googleAuth.ts; never NEXT_PUBLIC_; no client component imports googleAuth", () => {
    const files = walk("src");
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");
    expect(files.filter((f) => code(f).includes("GOOGLE_CLIENT_SECRET"))).toEqual([path.join("src", "lib", "googleAuth.ts")]);
    expect(files.filter((f) => /NEXT_PUBLIC_GOOGLE/.test(read(f)))).toEqual([]);
    for (const f of files) {
      const c = read(f);
      if (/^\s*["']use client["']/.test(c)) expect(c, f).not.toMatch(/@\/lib\/(googleAuth|prisma|passwordReset)["/]/);
    }
  });
  it("the link-intent cookie is httpOnly, SameSite=Lax, scoped to /api/auth, 10 minutes; connect and disconnect require the current password", () => {
    const route = read("src/app/api/account/google-link/route.ts");
    expect(route).toMatch(/httpOnly: true, secure: process\.env\.NODE_ENV === "production", sameSite: "lax", path: "\/api\/auth"/);
    expect(route).toContain("verifyPassword(parsed.data.currentPassword, user.passwordHash)");
    expect(read("src/lib/googleAuth.ts")).toContain("export const LINK_INTENT_TTL_MS = 10 * 60_000;");
  });
});

describe("error boundaries", () => {
  const err = Object.assign(new Error("SECRET internal detail: postgres://user:pw@host/db"), { digest: "abc123" });
  it("error.tsx shows a calm message + reference, never the error text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(createElement(AppError, { error: err, reset: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Reference: abc123");
    expect(html).not.toMatch(/SECRET|postgres|stack/i);
  });
  it("global-error.tsx renders its own document without the error text", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: err, reset: () => {} }));
    expect(html).toMatch(/^<html/);
    expect(html).not.toMatch(/SECRET|postgres/);
  });
});

describe("support contact", () => {
  it("shown only for a valid configured SUPPORT_EMAIL", () => {
    expect(supportEmail({})).toBeNull();
    expect(supportEmail({ SUPPORT_EMAIL: "help@teambalancepro.com" })).toBe("help@teambalancepro.com");
    expect(supportEmail({ SUPPORT_EMAIL: "javascript:alert(1)" })).toBeNull();
    expect(read("src/app/page.tsx")).toContain("{supportEmail() && (");
  });
});

describe("M12-A migration", () => {
  it("is additive only: two new tables, their indexes and foreign keys", () => {
    const sql = read("prisma/migrations/20261110120000_m12a_oauth_accounts/migration.sql").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/^\s*(DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b|\bRENAME\b|ALTER COLUMN|DROP COLUMN/im);
    expect(sql.match(/^\s*[A-Z]+ [A-Z]+/gm)!.map((x) => x.trim()).every((x) => ["CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE", "ALTER TABLE"].includes(x))).toBe(true);
    expect(sql.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "OAuthAccount"', 'CREATE TABLE "AccountLinkIntent"']);
  });
});
