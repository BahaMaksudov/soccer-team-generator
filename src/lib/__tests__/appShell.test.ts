import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * UI-3 — authenticated application shell + role-aware navigation.
 * Navigation is presentation only, built from server-authorized memberships;
 * the URL stays the tenant authority and every page re-checks access.
 */

const nav = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
const jwt = vi.hoisted(() => ({ token: null as null | { email: string } }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => jwt.token) }));

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { CHROME_HEADER, REDESIGN_CHROME } from "@/lib/chrome";
import AppShell from "@/components/app-shell/AppShell";
import {
  buildShellNav,
  groupAdminHref,
  initialsOf,
  shellContextFromPath,
  SIGN_OUT_DESTINATION,
  switcherEntries,
  type ShellData,
  type ShellOrganization,
} from "@/lib/appShell";
import { loadShellDataFor, type ShellDataSource } from "@/lib/appShellData";

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

const ORGS: ShellOrganization[] = [
  { slug: "eagles", name: "Eagles Club", role: "OWNER", groups: [{ slug: "indoor", name: "Indoor Soccer", sportLabel: "Soccer" }, { slug: "hoops", name: "Hoops Night", sportLabel: "Basketball" }] },
  { slug: "hawks", name: "Hawks", role: "MEMBER", groups: [{ slug: "sun", name: "Sunday", sportLabel: "Soccer" }] },
];
const data = (over: Partial<ShellData> = {}): ShellData => ({
  user: { name: "Pat Organizer", email: "pat@example.com" },
  organizations: ORGS,
  hasPlayerProfile: false,
  workspaceListAvailable: true,
  ...over,
});
const keys = (pathname: string, d = data(), hash = "") => buildShellNav({ data: d, pathname, hash }).map((i) => i.key);
const item = (pathname: string, key: string, d = data(), hash = "") => buildShellNav({ data: d, pathname, hash }).find((i) => i.key === key);

beforeEach(() => {
  nav.pathname = "/admin";
  jwt.token = null;
});

describe("tenant context comes only from the URL AND the authorized list", () => {
  it("resolves an authorized Group / Organization; anything else is neutral (null)", () => {
    expect(shellContextFromPath("/admin/o/eagles/g/indoor", ORGS)).toMatchObject({ organization: { slug: "eagles" }, group: { slug: "indoor" } });
    expect(shellContextFromPath("/admin/o/eagles/g/indoor/matches/m1", ORGS)?.group?.slug).toBe("indoor");
    expect(shellContextFromPath("/admin/o/eagles/members", ORGS)).toMatchObject({ organization: { slug: "eagles" }, group: null });
    for (const p of ["/admin/o/foreign/g/indoor", "/admin/o/eagles/g/foreign", "/admin/o/hawks/g/indoor", "/admin", "/me", "/g/eagles/indoor", "/admin/o/%E0%A4%A/g/x", null])
      expect(shellContextFromPath(p, ORGS), String(p)).toBeNull();
  });
});

describe("role-aware navigation (presentation only)", () => {
  const sections = (pathname: string, d = data()) => {
    const out: Record<string, string[]> = {};
    for (const i of buildShellNav({ data: d, pathname })) (out[i.section] ??= []).push(i.key);
    return out;
  };
  it("Group context: Group Management (Overview / Matches / Players / Group Settings) then Organization Management", () => {
    const items = buildShellNav({ data: data(), pathname: "/admin/o/eagles/g/indoor" });
    expect(items.filter((i) => i.section === "group").map((i) => [i.key, i.label, i.href])).toEqual([
      ["overview", "Overview", "/admin/o/eagles/g/indoor"],
      ["matches", "Matches", "/admin/o/eagles/g/indoor/matches"],
      ["players", "Players", "/admin/o/eagles/g/indoor/players"],
      ["group-settings", "Group Settings", "/admin/o/eagles/g/indoor/settings"],
    ]);
    expect(items.filter((i) => i.section === "organization").map((i) => [i.key, i.label, i.href])).toEqual([
      ["organization", "Organization Overview", "/admin/o/eagles"],
      ["groups", "Manage Groups", "/admin/o/eagles/groups"],
      ["members", "Members & Invitations", "/admin/o/eagles/members"],
      ["billing", "Billing & Subscription", "/admin/o/eagles/billing"],
    ]);
    expect(items.filter((i) => i.section === "account").map((i) => [i.key, i.label])).toEqual([["account", "Account settings"]]);
    // Sections come in hierarchy order: Group → Organization → Account.
    expect(Object.keys(sections("/admin/o/eagles/g/indoor"))).toEqual(["group", "organization", "account"]);
  });
  it("roles: ADMIN loses only Members; MEMBER sees read-only links (no Group Settings / Members / Billing)", () => {
    const asRole = (role: "OWNER" | "ADMIN" | "MEMBER") => data({ organizations: [{ ...ORGS[0], role }] });
    expect(sections("/admin/o/eagles/g/indoor", asRole("ADMIN"))).toMatchObject({
      group: ["overview", "matches", "players", "group-settings"],
      organization: ["organization", "groups", "billing"],
    });
    expect(sections("/admin/o/hawks/g/sun")).toMatchObject({ group: ["overview", "matches", "players"], organization: ["organization", "groups"] });
    expect(item("/admin/o/hawks/g/sun", "groups")?.label).toBe("Groups"); // view-only for a MEMBER
  });
  it("Organization pages (no Group selected): Organization Management only — no Group links", () => {
    expect(sections("/admin/o/eagles")).toEqual({ organization: ["organization", "groups", "members", "billing"], account: ["account"] });
    expect(item("/admin/o/eagles", "organization")?.active).toBe(true);
    expect(item("/admin/o/eagles/members", "members")?.active).toBe(true);
    expect(item("/admin/o/eagles/members", "organization")?.active).toBe(false);
    expect(item("/admin/o/eagles/billing", "billing")?.active).toBe(true);
    // On Organization pages its links lead the mobile bar.
    expect(buildShellNav({ data: data(), pathname: "/admin/o/eagles" }).filter((i) => i.mobilePrimary).map((i) => i.key)).toEqual(["organization", "groups", "billing"]);
  });
  it("neutral context (no Organization in the URL): Your workspaces + Account; never Organization links", () => {
    expect(keys("/admin")).toEqual(["workspaces", "account"]);
    expect(keys("/account/security")).toEqual(["workspaces", "account"]);
    expect(item("/admin", "workspaces")?.active).toBe(true);
    for (const p of ["/admin", "/me"]) for (const k of ["organization", "groups", "members", "billing"]) expect(keys(p)).not.toContain(k);
    // Outside an Organization, anyone with an Organization keeps a way back (/admin opens the only Group).
    expect(item("/me", "workspaces", data({ workspaceListAvailable: false }))?.href).toBe("/admin");
    expect(keys("/me", data({ organizations: [], workspaceListAvailable: false, hasPlayerProfile: true }))).not.toContain("workspaces");
  });
  it("My Games (player identity) appears only with a claimed Player profile (or on /me) — never organizer links", () => {
    expect(keys("/admin")).not.toContain("my-games");
    expect(keys("/admin", data({ hasPlayerProfile: true }))).toContain("my-games");
    expect(keys("/me")).toContain("my-games");
    const playerOnly = data({ organizations: [], hasPlayerProfile: true, workspaceListAvailable: false });
    expect(keys("/me", playerOnly)).toEqual(["my-games", "account"]);
  });
  it("Manage Groups is the Organization's Groups page (also active on /groups/new)", () => {
    expect(item("/admin/o/eagles/g/indoor", "groups", data({ workspaceListAvailable: false }))?.href).toBe("/admin/o/eagles/groups");
    expect(item("/admin/o/eagles/groups", "groups")?.active).toBe(true);
    expect(item("/admin/o/eagles/groups/new", "groups")?.active).toBe(true);
  });
  it("active state: exact page, match pages, settings, account — exactly one active item", () => {
    const g = "/admin/o/eagles/g/indoor";
    expect(item(g, "overview")?.active).toBe(true);
    expect(item(g, "matches")?.active).toBe(false);
    expect(item(`${g}/matches`, "matches")?.active).toBe(true);
    expect(item(`${g}/matches`, "overview")?.active).toBe(false);
    expect(item(`${g}/matchesx`, "matches")?.active).toBe(false);
    expect(item(`${g}/players`, "players")?.active).toBe(true);
    expect(item(`${g}/players`, "overview")?.active).toBe(false);
    expect(item(`${g}/matches/m1`, "matches")?.active).toBe(true);
    expect(item(`${g}/matches/m1`, "overview")?.active).toBe(false);
    expect(item(`${g}/settings`, "group-settings")?.active).toBe(true);
    expect(item("/account/security", "account")?.active).toBe(true);
    for (const p of [g, `${g}/matches/m1`, `${g}/settings`, "/admin/o/eagles", "/admin/o/eagles/groups/new", "/admin"])
      expect(buildShellNav({ data: data(), pathname: p }).filter((i) => i.active), p).toHaveLength(1);
  });
});

describe("group switcher", () => {
  it("lists exactly the authorized Organizations/Groups, with canonical (encoded) admin URLs and the current one marked", () => {
    const e = switcherEntries(ORGS, shellContextFromPath("/admin/o/eagles/g/hoops", ORGS));
    expect(e.map((o) => [o.organization.slug, o.organization.roleLabel, o.groups.map((g) => g.href)])).toEqual([
      ["eagles", "Owner", ["/admin/o/eagles/g/indoor", "/admin/o/eagles/g/hoops"]],
      ["hawks", "Member", ["/admin/o/hawks/g/sun"]],
    ]);
    expect(e.flatMap((o) => o.groups).filter((g) => g.current).map((g) => g.slug)).toEqual(["hoops"]);
    expect(groupAdminHref("a b", "c/d")).toBe("/admin/o/a%20b/g/c%2Fd");
  });
});

describe("Sign Out", () => {
  it("uses NextAuth signOut without its redirect, then a RELATIVE same-origin path", () => {
    expect(SIGN_OUT_DESTINATION).toBe("/login");
    const src = read("src/components/app-shell/ShellClient.tsx");
    expect(src).toContain("await signOut({ redirect: false });");
    expect(src).toContain("window.location.assign(SIGN_OUT_DESTINATION);");
    expect(src).not.toMatch(/https?:\/\/|teambalancepro|callbackUrl/);
  });
});

describe("rendered shell", () => {
  const render = (pathname: string, d = data()) => {
    nav.pathname = pathname;
    return renderToStaticMarkup(createElement(AppShell, { data: d } as { data: ShellData; children: ReactNode }, createElement("p", null, "PAGE")));
  };
  it("page content renders server-side inside <main>; sidebar + mobile nav are semantic and labelled", () => {
    const html = render("/admin/o/eagles/g/indoor");
    expect(html).toMatch(/<main id="main"[^>]*>[\s\S]*<p>PAGE<\/p>/);
    expect(html).toContain('aria-label="Application"');
    expect(html).toContain('aria-label="Application (mobile)"');
    expect(html).toMatch(/aria-label="Switch group\. Current: Eagles Club, Indoor Soccer"/);
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Overview/);
    expect(html).toContain('aria-label="Account menu"');
    expect(html).toMatch(/<aside[\s\S]*Sign out[\s\S]*<\/aside>/); // directly visible in the sidebar (also in the account menu / mobile More)
    expect(html).toContain("Owner · Eagles Club"); // real role of the current organization
    // Organization and Group are shown as separate, labelled concepts; nav sections are labelled.
    expect(html).toMatch(/>Organization<\/p>[\s\S]*?href="\/admin\/o\/eagles"[\s\S]*?Eagles Club/);
    expect(html).toMatch(/>Group<\/p>[\s\S]*?Indoor Soccer/);
    for (const label of ["Group Management", "Organization Management", "Account Settings"]) expect(html).toContain(label);
    expect(html).toContain('href="/admin/o/eagles/billing"');
    expect(html).not.toMatch(/SoccerTeam\.jpg/);
  });
  it("MEMBER context: no organizer-only links rendered", () => {
    const html = render("/admin/o/hawks/g/sun");
    expect(html).not.toContain("/admin/o/hawks/members"); // the OWNER-only Members page is never linked for a MEMBER
    expect(html).not.toContain("/admin/o/hawks/billing");
    expect(html).not.toContain("/admin/o/hawks/g/sun/settings");
    expect(html).toContain("Member · Hawks");
  });
  it("user with no organizations: no group switcher", () => {
    const html = render("/me", data({ organizations: [], workspaceListAvailable: false, hasPlayerProfile: true }));
    expect(html).not.toContain("Switch group");
    expect(html).not.toContain(">Organization</p>");
    expect(html).toContain('href="/me"');
  });
  it("initials", () => {
    expect(initialsOf("Pat Organizer", "x@y.z")).toBe("PO");
    expect(initialsOf(null, "sam.lee@example.com")).toBe("SL");
  });
});

describe("shell data (server): identity + OWN memberships only", () => {
  const user = { id: "u1", email: "pat@example.com", name: "Pat", emailVerifiedAt: new Date() as Date | null };
  const db = (u: typeof user | null, memberships: unknown[] = [], players = 0) =>
    ({
      user: { findUnique: vi.fn(async () => u) },
      organizationMembership: { findMany: vi.fn(async () => memberships) },
      player: { count: vi.fn(async () => players) },
    }) as unknown as ShellDataSource & { organizationMembership: { findMany: ReturnType<typeof vi.fn> } };
  const membership = (slug: string, role: string, groups: Array<{ slug: string; isActive: boolean }>) => ({
    role,
    organization: { id: slug, name: slug.toUpperCase(), slug, groups: groups.map((g) => ({ id: g.slug, name: g.slug, slug: g.slug, sportKey: "soccer", timezone: "UTC", isActive: g.isActive })) },
  });

  it("1: no session / unknown user / mismatched id → null (no shell data at all)", async () => {
    expect(await loadShellDataFor(null, db(user))).toBeNull();
    expect(await loadShellDataFor({ email: "" }, db(user))).toBeNull();
    expect(await loadShellDataFor({ email: "pat@example.com" }, db(null))).toBeNull();
    expect(await loadShellDataFor({ email: "pat@example.com", id: "someone-else" }, db(user))).toBeNull();
  });
  it("2/3: organizations come from the user's own memberships (by User id); inactive groups excluded", async () => {
    const d = db(user, [membership("eagles", "ADMIN", [{ slug: "a", isActive: true }, { slug: "old", isActive: false }])], 1);
    const out = await loadShellDataFor({ email: "PAT@example.com", id: "u1" }, d);
    expect(d.organizationMembership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
    expect(out).toEqual({
      user: { name: "Pat", email: "pat@example.com" },
      organizations: [{ slug: "eagles", name: "EAGLES", role: "ADMIN", groups: [{ slug: "a", name: "a", sportLabel: "Soccer" }] }],
      hasPlayerProfile: true,
      workspaceListAvailable: false, // one org, one group → /admin redirects
    });
  });
  it("an unverified account gets identity only (no organizations, no player data)", async () => {
    const d = db({ ...user, emailVerifiedAt: null }, [membership("eagles", "OWNER", [{ slug: "a", isActive: true }])], 3);
    expect(await loadShellDataFor({ email: "pat@example.com", id: "u1" }, d)).toEqual({
      user: { name: "Pat", email: "pat@example.com" },
      organizations: [],
      hasPlayerProfile: false,
      workspaceListAvailable: false,
    });
    expect(d.organizationMembership.findMany).not.toHaveBeenCalled();
  });
});

describe("middleware: app-shell routes keep the SAME auth gate", () => {
  it.each(["/admin", "/admin/o/x/g/y", "/me", "/account/security", "/onboarding"])("%s unauthenticated → login redirect, not tagged", async (p) => {
    const res = await middleware(new NextRequest(`http://localhost${p}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`http://localhost/login?callbackUrl=${encodeURIComponent(p)}`);
    expect(res.headers.get(`x-middleware-request-${CHROME_HEADER}`)).toBeNull();
  });
  it.each(["/admin", "/admin/o/x/g/y/matches/m", "/me", "/account/security", "/onboarding"])("%s authenticated → passes and is tagged for the new shell", async (p) => {
    jwt.token = { email: "pat@example.com" };
    const res = await middleware(new NextRequest(`http://localhost${p}`));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get(`x-middleware-request-${CHROME_HEADER}`)).toBe(REDESIGN_CHROME);
  });
  it("legacy protected routes pass the gate but are NOT tagged (old chrome); APIs never tagged", async () => {
    jwt.token = { email: "pat@example.com" };
    for (const p of ["/api/admin/organizations", "/api/account/change-password", "/api/invitations/accept"]) {
      const res = await middleware(new NextRequest(`http://localhost${p}`));
      expect(res.headers.get(`x-middleware-request-${CHROME_HEADER}`), p).toBeNull();
    }
    jwt.token = null;
    expect((await middleware(new NextRequest("http://localhost/api/admin/organizations"))).status).toBe(401);
  });
});

describe("no Lovable mock data / preview infrastructure at runtime", () => {
  const files = [
    "src/lib/appShell.ts",
    "src/lib/appShellData.ts",
    "src/components/app-shell/AppShell.tsx",
    "src/components/app-shell/ShellClient.tsx",
    "src/components/app-shell/AuthenticatedShell.tsx",
    "src/app/admin/page.tsx",
  ];
  it.each(files)("%s", (f) => {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).not.toMatch(/AppPreview|usePreview|VARIANTS|MATCH_STAGES|Design preview|Bahrom|New England Eagles|Sunday Pickup|Yasmina|@tanstack|localStorage|sessionStorage|document\.cookie/);
  });
  it("the shell layouts (and in-shell 404s) exist for exactly /admin, /me, /account and (UI-7) /onboarding", () => {
    for (const d of ["admin", "me", "account", "onboarding"]) {
      expect(read(`src/app/${d}/layout.tsx`)).toContain("<AuthenticatedShell>");
      expect(read(`src/app/${d}/not-found.tsx`)).toContain("ShellNotFound");
    }
    for (const f of ["src/app/admin/[...missing]/page.tsx", "src/app/me/[...missing]/page.tsx", "src/app/account/[[...missing]]/page.tsx"])
      expect(read(f)).toMatch(/notFound\(\);/);
    // One message for missing AND unauthorized (never reveals whether a tenant exists).
    expect(read("src/components/app-shell/ShellNotFound.tsx")).toContain("This page doesn&apos;t exist, or you don&apos;t have access to it.");
    expect(fs.existsSync(path.join(root, "src/app/claim/layout.tsx"))).toBe(false); // still legacy
  });
});
