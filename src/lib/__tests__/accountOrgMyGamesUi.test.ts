import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * UI-6 — Organization / Account / My Games: real data only, no invented
 * features, no balancing data on player surfaces, no secrets or internal ids.
 */
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const myGamesPage = read("src/app/me/page.tsx");
const myGamesLib = read("src/lib/myGames.ts");
const account = read("src/app/account/security/page.tsx");
const org = read("src/app/admin/o/[organizationSlug]/page.tsx");

describe("My Games (player surface)", () => {
  it("built only from the session User's claimed Players; no balancing data selected or rendered", () => {
    expect(myGamesLib).toContain("where: { userId, group: { isActive: true } }");
    for (const src of [strip(myGamesLib), strip(myGamesPage)]) expect(src).not.toMatch(/rating|stamina|balanceWeight|metricsJson|impact/i);
    expect(myGamesLib).toContain("publishedPostGame(m, m.generation?.teamsJson ?? null)");
  });
  it("one <h1> per page: the empty-state title is an h2 under the page heading (h1 only when it IS the page)", () => {
    expect(myGamesPage).toContain('heading = "h2"');
    expect(myGamesPage).toContain('<EmptyState title="Verify your email" heading="h1">');
    expect(myGamesPage).toContain('<EmptyState title="No player profile connected">');
  });
  it("empty state when no Player is claimed (no fake games); verification gate kept", () => {
    expect(myGamesPage).toContain("No player profile connected");
    expect(myGamesPage).toContain("Verify your email address to see your games.");
  });
  it("voting is informational (Telegram poll) — no web vote action is invented", () => {
    expect(strip(myGamesPage)).not.toMatch(/fetch\(|vote_mvp|\/api\//);
    expect(myGamesPage).toContain("Player of the Match voting is open in your group&apos;s Telegram poll.");
  });
});

describe("Account", () => {
  it("only real sign-in methods; Google shown only when configured; never ids/hashes/tokens", () => {
    expect(account).toContain("isGoogleAuthConfigured()");
    expect(strip(account)).not.toMatch(/passwordHash|token|\{account\.id\}|telegramUserId|userId:\s*\w+\.id\}/);
    expect(account).toContain("<ChangePasswordForm />");
    expect(account).toContain("You sign in with Google. This account has no password.");
  });
  it("memberships and claimed Players only for a verified account; nothing created", () => {
    expect(account).toMatch(/if \(account\.emailVerified\) \{\s*organizations = await listAccessibleTenants\(\);/);
    expect(strip(account)).not.toMatch(/\.create\(|\.upsert\(|\.update\(/);
  });
});

describe("Organization", () => {
  it("membership-verified by URL; members & invitations data only for OWNER; no invented settings", () => {
    expect(org).toContain("requireOrganizationContextForSlug({ organizationSlug })");
    expect(org).toContain('isOwner ? listOrganizationMembers(context) : Promise.resolve(null)');
    // M11.2A — Billing is real now (a link to the Billing page for OWNER/ADMIN, behind the plan card); nothing else invented.
    expect(strip(org)).not.toMatch(/WhatsApp|rename|archive|Delete organization/i);
    expect(strip(org)).toMatch(/\{plan && \([\s\S]*?\/billing/);
  });
});
