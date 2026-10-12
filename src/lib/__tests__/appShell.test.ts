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

const nav = vi.hoisted(() => ({ pathname: "/admin", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useSearchParams: () => new URLSearchParams(nav.search) }));
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
  accountSettingsHref,
  buildShellNav,
  shellContextFromLocation,
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
  ...over,
});
const keys = (pathname: string, d = data(), hash = "") => buildShellNav({ data: d, pathname, hash }).map((i) => i.key);
const item = (pathname: string, key: string, d = data(), hash = "") => buildShellNav({ data: d, pathname, hash }).find((i) => i.key === key);

beforeEach(() => {
  nav.pathname = "/admin";
  nav.search = "";
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

describe("Phase 3 — context-sensitive navigation (presentation only)", () => {
  const sections = (pathname: string, d = data()) => {
    const out: Record<string, string[]> = {};
    for (const i of buildShellNav({ data: d, pathname })) (out[i.section] ??= []).push(i.key);
    return out;
  };
  const labels = (pathname: string, d = data()) => buildShellNav({ data: d, pathname }).map((i) => [i.label, i.href]);

  it("State A (no Organization selected): My Organizations + Account Settings only — no Organization or Group links", () => {
    for (const p of ["/admin", "/account/security", "/onboarding"]) {
      expect(labels(p), p).toEqual([
        ["My Organizations", "/admin"],
        ["Account Settings", "/account/security"],
      ]);
    }
    expect(item("/admin", "organizations")?.active).toBe(true);
    // A new User without Organizations gets the same (the page welcomes them).
    expect(keys("/admin", data({ organizations: [] }))).toEqual(["organizations", "account"]);
  });

  it("State B (Organization selected, no Group): My Groups, Overview, Members, Billing & Plan, All Organizations — no Group links", () => {
    expect(labels("/admin/o/eagles/groups")).toEqual([
      ["My Groups", "/admin/o/eagles/groups"],
      ["Organization Overview", "/admin/o/eagles"],
      ["Members & Invitations", "/admin/o/eagles/members"],
      ["Billing & Plan", "/admin/o/eagles/billing"],
      ["All Organizations", "/admin"],
      ["Account Settings", "/account/security?o=eagles"], // Phase 3.1 — keeps the context
    ]);
    for (const p of ["/admin/o/eagles", "/admin/o/eagles/groups", "/admin/o/eagles/groups/new", "/admin/o/eagles/members", "/admin/o/eagles/billing"]) {
      expect(sections(p).group, p).toBeUndefined();
      expect(keys(p), p).not.toContain("all-groups");
    }
    expect(item("/admin/o/eagles/groups/new", "groups")?.active).toBe(true);
  });

  it("State C (Group selected): Overview, Players, Matches, Group Settings, All Groups — no Organization management links", () => {
    expect(labels("/admin/o/eagles/g/indoor")).toEqual([
      ["Overview", "/admin/o/eagles/g/indoor"],
      ["Players", "/admin/o/eagles/g/indoor/players"],
      ["Matches", "/admin/o/eagles/g/indoor/matches"],
      ["Group Settings", "/admin/o/eagles/g/indoor/settings"],
      ["All Groups", "/admin/o/eagles/groups"],
      ["Account Settings", "/account/security?o=eagles&g=indoor"], // Phase 3.1 — keeps the context
    ]);
    for (const k of ["organization", "members", "billing", "groups", "organizations"]) expect(keys("/admin/o/eagles/g/indoor/matches/m1"), k).not.toContain(k);
    // Recurring schedules stay inside Matches — no separate Schedules item.
    expect(keys("/admin/o/eagles/g/indoor").some((k) => /schedule/i.test(k))).toBe(false);
  });

  it("roles: ADMIN loses only Members; MEMBER sees no Members, Billing or Group Settings", () => {
    const asRole = (role: "OWNER" | "ADMIN" | "MEMBER") => data({ organizations: [{ ...ORGS[0], role }] });
    expect(keys("/admin/o/eagles", asRole("ADMIN"))).toEqual(["groups", "organization", "billing", "organizations", "account"]);
    expect(keys("/admin/o/eagles", asRole("MEMBER"))).toEqual(["groups", "organization", "organizations", "account"]);
    expect(keys("/admin/o/eagles/g/indoor", asRole("ADMIN"))).toContain("group-settings");
    expect(keys("/admin/o/hawks/g/sun")).toEqual(["overview", "players", "matches", "all-groups", "account"]); // MEMBER
  });

  it("foreign / unknown slugs in the URL never produce a context (State A); the page itself 404s", () => {
    for (const p of ["/admin/o/foreign/groups", "/admin/o/eagles/g/foreign", "/admin/o/hawks/g/indoor"]) expect(keys(p), p).toEqual(["organizations", "account"]);
  });

  it("My Games (player identity) appears only with a claimed Player profile (or on /me), in every state", () => {
    expect(keys("/admin")).not.toContain("my-games");
    expect(keys("/admin", data({ hasPlayerProfile: true }))).toContain("my-games");
    expect(keys("/admin/o/eagles/g/indoor", data({ hasPlayerProfile: true }))).toContain("my-games");
    expect(keys("/me")).toContain("my-games");
    expect(keys("/me", data({ organizations: [], hasPlayerProfile: true }))).toEqual(["organizations", "my-games", "account"]);
  });

  it("active state: exact page, match pages, settings, account — exactly one active item", () => {
    const g = "/admin/o/eagles/g/indoor";
    expect(item(g, "overview")?.active).toBe(true);
    expect(item(`${g}/matches`, "matches")?.active).toBe(true);
    expect(item(`${g}/matchesx`, "matches")?.active).toBe(false);
    expect(item(`${g}/players`, "players")?.active).toBe(true);
    expect(item(`${g}/matches/m1`, "matches")?.active).toBe(true);
    expect(item(`${g}/matches/m1`, "overview")?.active).toBe(false);
    expect(item(`${g}/settings`, "group-settings")?.active).toBe(true);
    expect(item("/admin/o/eagles/members", "members")?.active).toBe(true);
    expect(item("/admin/o/eagles/members", "organization")?.active).toBe(false);
    expect(item("/account/security", "account")?.active).toBe(true);
    for (const p of [g, `${g}/matches/m1`, `${g}/settings`, "/admin/o/eagles", "/admin/o/eagles/groups/new", "/admin/o/eagles/billing", "/admin", "/account/security"])
      expect(buildShellNav({ data: data(), pathname: p }).filter((i) => i.active), p).toHaveLength(1);
  });

  it("mobile: the bottom bar shows the state's main destinations (max 4); the rest go under More", () => {
    const primary = (p: string) => buildShellNav({ data: data(), pathname: p }).filter((i) => i.mobilePrimary).map((i) => i.key);
    expect(primary("/admin")).toEqual(["organizations"]);
    expect(primary("/admin/o/eagles")).toEqual(["groups", "organization", "organizations"]);
    expect(primary("/admin/o/eagles/g/indoor")).toEqual(["overview", "players", "matches"]);
  });
});

describe("Phase 3.1 — Account Settings keeps the sidebar context (URL ?o=&g=, validated against memberships)", () => {
  const ORGS2: ShellOrganization[] = [
    { slug: "nee", name: "New England Eagles", role: "OWNER", groups: [{ slug: "indoor-soccer", name: "Indoor Soccer", sportLabel: "Soccer" }, { slug: "pickup-basketball", name: "Pickup basketball", sportLabel: "Basketball" }] },
    { slug: "hawks", name: "Hawks", role: "MEMBER", groups: [{ slug: "sun", name: "Sunday", sportLabel: "Soccer" }] },
  ];
  const d2 = data({ organizations: ORGS2 });
  const navAt = (path: string, d = d2) => {
    const url = new URL(path, "http://x");
    return buildShellNav({ data: d, pathname: url.pathname, search: url.searchParams });
  };
  const accountHrefFrom = (path: string) => navAt(path).find((i) => i.key === "account")!.href;

  it("the Account Settings link carries the current context (none on My Organizations)", () => {
    expect(accountHrefFrom("/admin")).toBe("/account/security");
    expect(accountHrefFrom("/admin/o/nee/groups")).toBe("/account/security?o=nee");
    expect(accountHrefFrom("/admin/o/nee/g/indoor-soccer/matches")).toBe("/account/security?o=nee&g=indoor-soccer");
    expect(accountHrefFrom("/admin/o/nee/g/pickup-basketball")).toBe("/account/security?o=nee&g=pickup-basketball");
    expect(accountSettingsHref({ organization: { slug: "a b", name: "", role: "OWNER", groups: [] }, group: null })).toBe("/account/security?o=a+b");
  });

  it("Case 1 — from My Organizations: State A kept, Account Settings active", () => {
    const items = navAt("/account/security");
    expect(items.map((i) => i.key)).toEqual(["organizations", "account"]);
    expect(items.filter((i) => i.active).map((i) => i.key)).toEqual(["account"]);
  });

  it("Case 2 — from My Groups: the organization stays selected with its links (role-aware); only Account Settings active", () => {
    const items = navAt("/account/security?o=nee");
    expect(items.map((i) => i.label)).toEqual(["My Groups", "Organization Overview", "Members & Invitations", "Billing & Plan", "All Organizations", "Account Settings"]);
    expect(items.filter((i) => i.active).map((i) => i.key)).toEqual(["account"]);
    expect(navAt("/account/security?o=hawks").map((i) => i.key)).toEqual(["groups", "organization", "organizations", "account"]); // MEMBER
    expect(items.find((i) => i.key === "account")!.href).toBe("/account/security?o=nee"); // refresh/bookmark keep it
  });

  it("Case 3 — from a group (Indoor Soccer, Pickup basketball): group navigation kept, links go to that group; only Account Settings active", () => {
    for (const g of ["indoor-soccer", "pickup-basketball"]) {
      const items = navAt(`/account/security?o=nee&g=${g}`);
      expect(items.map((i) => [i.key, i.href]), g).toEqual([
        ["overview", `/admin/o/nee/g/${g}`],
        ["players", `/admin/o/nee/g/${g}/players`],
        ["matches", `/admin/o/nee/g/${g}/matches`],
        ["group-settings", `/admin/o/nee/g/${g}/settings`],
        ["all-groups", "/admin/o/nee/groups"],
        ["account", `/account/security?o=nee&g=${g}`],
      ]);
      expect(items.filter((i) => i.active).map((i) => i.key)).toEqual(["account"]);
    }
  });

  it("invalid or unauthorized context is ignored (State A): foreign org, foreign / unknown group, group without org, malformed, oversized", () => {
    for (const q of ["?o=foreign", "?o=hawks&g=indoor-soccer", "?o=nee&g=nope", "?g=indoor-soccer", "?o=%E0%A4%A", "?o=" + "x".repeat(201), "?o=nee&g=" + "y".repeat(201)]) {
      expect(navAt(`/account/security${q}`).map((i) => i.key), q).toEqual(["organizations", "account"]);
    }
  });

  it("the ?o=&g= context applies only on Account pages — /admin URLs keep their own context", () => {
    expect(shellContextFromLocation("/admin", new URLSearchParams("o=nee&g=indoor-soccer"), ORGS2)).toBeNull();
    expect(shellContextFromLocation("/admin/o/hawks", new URLSearchParams("o=nee"), ORGS2)?.organization.slug).toBe("hawks");
    expect(shellContextFromLocation("/me", new URLSearchParams("o=nee"), ORGS2)).toBeNull();
  });

  it("rendered on Account Settings from a group: org context, group switcher, group links, Account Settings marked current (desktop + mobile)", () => {
    nav.pathname = "/account/security";
    nav.search = "o=nee&g=pickup-basketball";
    const html = renderToStaticMarkup(createElement(AppShell, { data: d2 } as { data: ShellData; children: ReactNode }, createElement("p", null, "PAGE")));
    expect(html).toMatch(/aria-label="Switch group\. Current: New England Eagles, Pickup basketball"/);
    expect(html).toContain('href="/admin/o/nee/g/pickup-basketball/players"');
    expect(html).toContain('href="/admin/o/nee/groups"');
    expect(html).toMatch(/href="\/account\/security\?o=nee&amp;g=pickup-basketball"[^>]*aria-current="page"/);
    expect(html).not.toContain('href="/admin/o/nee/members"'); // no organization management in the group state
    expect(html).toContain('aria-label="Application (mobile)"');
    // The account menu's Account link carries the same context.
    expect(html).not.toMatch(/href="\/account\/security"[^?]/);
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
  it("Phase 3: the rendered switcher lists ONLY the selected Organization's Groups (never another Organization's)", () => {
    nav.pathname = "/admin/o/eagles/g/hoops";
    const html = renderToStaticMarkup(createElement(AppShell, { data: data() } as { data: ShellData; children: ReactNode }, createElement("p", null, "PAGE")));
    // The panel is closed in static markup: assert the source contract instead.
    const src = read("src/components/app-shell/ShellClient.tsx");
    expect(src).toContain("const entries = ctx ? switcherEntries([ctx.organization], ctx) : [];");
    expect(src).toContain("if (!ctx?.group) return null;");
    expect(src).not.toContain("switcherEntries(data.organizations");
    expect(html).not.toContain("/admin/o/hawks"); // nothing of the other Organization anywhere in the shell
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
    expect(html).not.toMatch(/SoccerTeam\.jpg/);
  });
  it("State C: Organization shown as plain context (no management link), the Group with its switcher, All Groups; no Organization management", () => {
    const html = render("/admin/o/eagles/g/indoor");
    expect(html).toMatch(/>Organization<\/p>[\s\S]*?Eagles Club/);
    expect(html).toMatch(/>Group<\/p>[\s\S]*?Indoor Soccer/);
    expect(html).not.toContain('href="/admin/o/eagles"');
    for (const h of ["/admin/o/eagles/members", "/admin/o/eagles/billing"]) expect(html).not.toContain(`href="${h}"`);
    expect(html).toContain('href="/admin/o/eagles/groups"'); // All Groups
    expect(html).toContain(">All Groups<");
  });
  it("State B: the selected Organization and its management links; no group switcher or Group navigation", () => {
    const html = render("/admin/o/eagles/groups");
    expect(html).toMatch(/>Organization<\/p>[\s\S]*?href="\/admin\/o\/eagles"[\s\S]*?Eagles Club/);
    expect(html).not.toContain("Switch group");
    expect(html).not.toContain(">Group<\/p>");
    for (const t of [">My Groups<", ">Organization Overview<", ">Members &amp; Invitations<", ">Billing &amp; Plan<", ">All Organizations<"]) expect(html).toContain(t);
    expect(html).not.toContain('href="/admin/o/eagles/g/');
  });
  it("State A: no Organization block, no group switcher, no Organization links", () => {
    const html = render("/admin");
    expect(html).not.toContain("Switch group");
    expect(html).not.toContain(">Organization</p>");
    expect(html).not.toContain('href="/admin/o/');
    expect(html).toContain(">My Organizations<");
    expect(html).toContain(">Account Settings<");
  });
  it("MEMBER context: no organizer-only links rendered", () => {
    const html = render("/admin/o/hawks/g/sun");
    expect(html).not.toContain("/admin/o/hawks/members"); // the OWNER-only Members page is never linked for a MEMBER
    expect(html).not.toContain("/admin/o/hawks/billing");
    expect(html).not.toContain("/admin/o/hawks/g/sun/settings");
    expect(html).toContain("Member · Hawks");
  });
  it("user with no organizations: no group switcher", () => {
    const html = render("/me", data({ organizations: [], hasPlayerProfile: true }));
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
    });
  });
  it("an unverified account gets identity only (no organizations, no player data)", async () => {
    const d = db({ ...user, emailVerifiedAt: null }, [membership("eagles", "OWNER", [{ slug: "a", isActive: true }])], 3);
    expect(await loadShellDataFor({ email: "pat@example.com", id: "u1" }, d)).toEqual({
      user: { name: "Pat", email: "pat@example.com" },
      organizations: [],
      hasPlayerProfile: false,
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
