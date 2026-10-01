import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** M5 — static invariants for email verification / invitations / provider secrets. */
const root = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.i?test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const sources = walk("src").map((f) => [f, stripComments(read(f))] as const);
const exportedHandlers = (src: string) => [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);

describe("link-scanner safety: GET pages never consume single-use tokens", () => {
  it("/verify-email/[token] only reads (preview); consumption is the POST API", () => {
    const page = stripComments(read("src/app/verify-email/[token]/page.tsx"));
    expect(page).toContain("getVerificationPreview(");
    expect(page).not.toMatch(/verifyEmailToken|updateMany|\.update\(|\.delete/);
    expect(exportedHandlers(stripComments(read("src/app/api/verify-email/route.ts")))).toEqual(["POST"]);
  });

  it("/invite/[token] only reads; acceptance is the POST API", () => {
    const page = stripComments(read("src/app/invite/[token]/page.tsx"));
    expect(page).toContain("getInvitationPreview(");
    expect(page).not.toMatch(/acceptInvitation|consumeInvitation|updateMany/);
    expect(exportedHandlers(stripComments(read("src/app/api/invitations/accept/route.ts")))).toEqual(["POST"]);
  });

  it("sign-up, resend and organization creation are POST-only", () => {
    for (const f of [
      "src/app/api/signup/route.ts",
      "src/app/api/account/resend-verification/route.ts",
      "src/app/api/account/change-password/route.ts",
      "src/app/api/admin/organizations/route.ts",
    ]) {
      expect(exportedHandlers(stripComments(read(f))), f).toEqual(["POST"]);
    }
  });
});

describe("provider secret and transport isolation", () => {
  it("RESEND_API_KEY is read only by the server-side email transport, never as NEXT_PUBLIC_", () => {
    const users = sources.filter(([, c]) => /RESEND_API_KEY/.test(c)).map(([f]) => f);
    expect(users).toEqual([path.join("src", "lib", "email", "transport.ts")]);
    expect(sources.filter(([, c]) => /NEXT_PUBLIC_[A-Z_]*(RESEND|EMAIL|API_KEY)/.test(c))).toEqual([]);
  });

  it("no client component imports the email module, Prisma, or token services", () => {
    for (const [f, c] of sources) {
      if (!/^\s*["']use client["']/.test(c)) continue;
      expect(c, f).not.toMatch(/@\/lib\/(email|prisma|emailVerification|invitations|signup|secureToken)["/]/);
    }
  });

  it("the Resend endpoint is called only from the transport", () => {
    expect(sources.filter(([, c]) => /api\.resend\.com/.test(c)).map(([f]) => f)).toEqual([path.join("src", "lib", "email", "transport.ts")]);
  });

  it("email links are built from APP_BASE_URL, never from request headers", () => {
    for (const f of ["src/lib/email/index.ts", "src/lib/email/config.ts"]) {
      expect(stripComments(read(f)), f).not.toMatch(/headers|\bhost\b|x-forwarded/i);
    }
  });
});

describe("invitations are consumed only by explicit acceptance", () => {
  it("sign-up and email verification never consume an invitation or create a membership", () => {
    for (const f of ["src/lib/signup.ts", "src/lib/emailVerification.ts"]) {
      const c = stripComments(read(f));
      expect(c, f).not.toMatch(/consumeInvitationInTx|organizationMembership|organizationInvitation\.update/);
    }
  });
});

describe("M5.1 — Change Password stays narrow; no env credentials", () => {
  it("the route resolves the User only from the session and the service writes only passwordHash", () => {
    const route = stripComments(read("src/app/api/account/change-password/route.ts"));
    expect(route).toContain("requireSessionAccount()");
    expect(route).toContain("changePassword(account.id, parsed.data)");
    const svc = stripComments(read("src/lib/changePassword.ts"));
    const writes = [...svc.matchAll(/data:\s*\{([^}]*)\}/g)].map((m) => m[1].trim());
    expect(writes).toEqual(["passwordHash"]);
    expect(svc).not.toMatch(/emailVerifiedAt|organizationMembership|console\.(log|info|error)/);
  });

  it("no production source reads env-based admin credentials (fallback retired)", () => {
    expect(sources.filter(([, c]) => /ADMIN_PASSWORD_HASH|ADMIN_EMAIL/.test(c)).map(([f]) => f)).toEqual([]);
  });
});

describe("M6-A — visibility & share-link invariants", () => {
  it("every slug-addressed player-facing resolver passes an access check (non-PUBLIC fails closed otherwise)", () => {
    const callers = sources.filter(([f, c]) => /resolvePublicGroup\(/.test(c) && !f.endsWith(path.join("lib", "publicGroup.ts")));
    expect(callers.length).toBeGreaterThanOrEqual(6);
    for (const [f, c] of callers) {
      if (f.endsWith(path.join("lib", "groupAccess.ts"))) continue;
      expect(c, f).toContain("canViewNonPublic: viewerIsOrganizationMember");
    }
  });

  it("share tokens are never part of a route path (fragment + POST body only)", () => {
    expect(fs.existsSync(path.join(root, "src/app/share/[token]"))).toBe(false);
    expect(exportedHandlers(stripComments(read("src/app/api/share/view/route.ts")))).toEqual(["POST"]);
    expect(stripComments(read("src/lib/shareLinks.ts"))).toContain("`${SHARE_PATH}#${token}`");
  });

  it("public pages and share views build teams through the player-facing allow-list", () => {
    for (const f of [
      "src/app/g/[organizationSlug]/[groupSlug]/data.ts",
      "src/app/g/[organizationSlug]/[groupSlug]/print/[generationId]/data.ts",
      "src/lib/shareLinks.ts",
    ]) {
      const c = stripComments(read(f));
      expect(c, f).toContain("toPlayerFacingTeams(");
      expect(c, f).not.toMatch(/JSON\.parse\([^)]*teamsJson/);
    }
  });

  it("the share view, page and API never log tokens", () => {
    for (const f of ["src/lib/shareLinks.ts", "src/app/api/share/view/route.ts", "src/app/share/ShareView.tsx"]) {
      expect(stripComments(read(f)), f).not.toMatch(/console\./);
    }
  });
});
