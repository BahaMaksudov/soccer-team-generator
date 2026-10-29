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
  planAction,
  planIndicatorLabel,
  type ShellData,
  type ShellOrganization,
  type ShellPlan,
} from "@/lib/appShell";
import { loadShellDataFor, shellPlanOf, type ShellDataSource } from "@/lib/appShellData";

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

  it("State C (Group selected): Overview, Players, Matches, Group Settings, Billing & Plan (this Organization), All Groups — no other Organization management links", () => {
    expect(labels("/admin/o/eagles/g/indoor")).toEqual([
      ["Overview", "/admin/o/eagles/g/indoor"],
      ["Players", "/admin/o/eagles/g/indoor/players"],
      ["Matches", "/admin/o/eagles/g/indoor/matches"],
      ["Group Settings", "/admin/o/eagles/g/indoor/settings"],
      ["Billing & Plan", "/admin/o/eagles/billing"], // reachable from inside any group (OWNER/ADMIN)
      ["All Groups", "/admin/o/eagles/groups"],
      ["Account Settings", "/account/security?o=eagles&g=indoor"], // Phase 3.1 — keeps the context
    ]);
    expect(item("/admin/o/eagles/g/indoor", "billing")).toMatchObject({ section: "organization", mobilePrimary: false, active: false });
    for (const k of ["organization", "members", "groups", "organizations"]) expect(keys("/admin/o/eagles/g/indoor/matches/m1"), k).not.toContain(k);
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
        ["billing", "/admin/o/nee/billing"],
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
  it("State C: Organization shown as plain context, the Group with its switcher, Billing & Plan and All Groups; no other Organization management", () => {
    const html = render("/admin/o/eagles/g/indoor");
    expect(html).toMatch(/>Organization<\/p>[\s\S]*?Eagles Club/);
    expect(html).toMatch(/>Group<\/p>[\s\S]*?Indoor Soccer/);
    expect(html).not.toContain('href="/admin/o/eagles"');
    expect(html).not.toContain('href="/admin/o/eagles/members"');
    expect(html).toMatch(/href="\/admin\/o\/eagles\/billing"[^>]*>[\s\S]*?Billing &amp; Plan/);
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
  const db = (u: typeof user | null, memberships: unknown[] = [], players = 0, planRows: unknown[] = []) =>
    ({
      user: { findUnique: vi.fn(async () => u) },
      organizationMembership: { findMany: vi.fn(async () => memberships) },
      player: { count: vi.fn(async () => players) },
      organization: { findMany: vi.fn(async () => planRows) },
    }) as unknown as ShellDataSource & { organizationMembership: { findMany: ReturnType<typeof vi.fn> }; organization: { findMany: ReturnType<typeof vi.fn> } };
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
      billingEnabled: false,
    });
  });
  it("an unverified account gets identity only (no organizations, no player data)", async () => {
    const d = db({ ...user, emailVerifiedAt: null }, [membership("eagles", "OWNER", [{ slug: "a", isActive: true }])], 3);
    expect(await loadShellDataFor({ email: "pat@example.com", id: "u1" }, d)).toEqual({
      user: { name: "Pat", email: "pat@example.com" },
      organizations: [],
      hasPlayerProfile: false,
      billingEnabled: false,
    });
    expect(d.organizationMembership.findMany).not.toHaveBeenCalled();
    expect(d.organization.findMany).not.toHaveBeenCalled();
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

describe("sidebar plan indicator + Billing & Plan from any group", () => {
  const P = (kind: ShellPlan["kind"], extra: Partial<ShellPlan> = {}): ShellPlan => ({ kind, trialDaysLeft: null, interval: null, ...extra });
  const org = (role: "OWNER" | "ADMIN" | "MEMBER", plan: ShellPlan | null = P("FREE"), slug = "eagles"): ShellOrganization => ({ ...ORGS[0], slug, role, ...(plan ? { plan } : {}) });
  const render = (pathname: string, d: ShellData) => {
    nav.pathname = pathname;
    return renderToStaticMarkup(createElement(AppShell, { data: d } as { data: ShellData; children: ReactNode }, createElement("p", null, "PAGE")));
  };
  const sidebar = (html: string) => /<aside[\s\S]*?<\/aside>/.exec(html)![0];
  const mobileHeader = (html: string) => /<header[\s\S]*?<\/header>/.exec(html)![0];

  it("labels for every effective plan (an active trial is never 'Free'; unknown interval → 'Pro Plan')", () => {
    expect(planIndicatorLabel(P("FREE"))).toBe("Free Plan");
    expect(planIndicatorLabel(P("TRIAL", { trialDaysLeft: 12 }))).toBe("Pro Trial · 12 days left");
    expect(planIndicatorLabel(P("TRIAL", { trialDaysLeft: 1 }))).toBe("Pro Trial · 1 day left");
    expect(planIndicatorLabel(P("PRO", { interval: "month" }))).toBe("Pro · Monthly");
    expect(planIndicatorLabel(P("PRO", { interval: "year" }))).toBe("Pro · Yearly");
    expect(planIndicatorLabel(P("PRO"))).toBe("Pro Plan");
    expect(planIndicatorLabel(P("LEGACY"))).toBe("Early Access");
    expect(planIndicatorLabel(P("COMP"))).toBe("Complimentary Pro");
  });

  it("shellPlanOf follows the enforced rules (effectivePlan + trialDaysLeft; interval only for paid Pro)", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const row = (plan: "FREE" | "PRO" | "COMP" | "LEGACY", trialEndsAt: Date | null = null, interval: string | null = null) => ({ id: "o", plan, trialEndsAt, billingSubscriptions: interval === undefined ? [] : [{ interval }] });
    expect(shellPlanOf(row("FREE"), now)).toEqual(P("FREE"));
    expect(shellPlanOf(row("FREE", new Date("2026-11-07T11:00:00Z")), now)).toEqual(P("TRIAL", { trialDaysLeft: 10 }));
    expect(shellPlanOf(row("FREE", new Date("2026-10-28T11:00:00Z")), now)).toEqual(P("FREE")); // ended trial
    expect(shellPlanOf(row("PRO", null, "month"), now)).toEqual(P("PRO", { interval: "month" }));
    expect(shellPlanOf(row("PRO", null, "year"), now)).toEqual(P("PRO", { interval: "year" }));
    expect(shellPlanOf({ id: "o", plan: "PRO", trialEndsAt: null, billingSubscriptions: [] }, now)).toEqual(P("PRO"));
    expect(shellPlanOf(row("PRO", null, "weekly"), now)).toEqual(P("PRO")); // never guessed
    expect(shellPlanOf(row("LEGACY", null, "month"), now)).toEqual(P("LEGACY"));
    expect(shellPlanOf(row("COMP"), now)).toEqual(P("COMP"));
  });

  it("owner actions: Free → Upgrade to Pro, trial → Choose Pro Plan (this organization's Billing); none for paid / comp / Early Access, non-owners or billing off", () => {
    expect(planAction(org("OWNER", P("FREE")), true)).toEqual({ label: "Upgrade to Pro", href: "/admin/o/eagles/billing" });
    expect(planAction(org("OWNER", P("TRIAL", { trialDaysLeft: 5 })), true)).toEqual({ label: "Choose Pro Plan", href: "/admin/o/eagles/billing" });
    for (const k of ["PRO", "COMP", "LEGACY"] as const) expect(planAction(org("OWNER", P(k)), true), k).toBeNull();
    for (const r of ["ADMIN", "MEMBER"] as const) expect(planAction(org(r, P("FREE")), true), r).toBeNull();
    expect(planAction(org("OWNER", P("FREE")), false)).toBeNull();
    expect(planAction(org("OWNER", null), true)).toBeNull();
  });

  const profile = (html: string) => /aria-label="Account menu"[\s\S]*?Sign out/.exec(sidebar(html))![0]; // bottom-left user profile
  const orgHeader = (html: string) => sidebar(html).split('aria-label="Application"')[0]; // top organization section
  const count = (html: string, t: string) => html.split(t).length - 1;

  it("OWNER on Free inside a group: the bottom profile reads name → role · organization → plan → Upgrade to Pro (this organization's Billing); the top shows name + role only", () => {
    const html = render("/admin/o/eagles/g/indoor", data({ organizations: [org("OWNER"), ORGS[1]], billingEnabled: true }));
    expect(profile(html)).toMatch(/Pat Organizer[\s\S]*?Owner · Eagles Club[\s\S]*?<span class="sr-only">Plan: <\/span>Free Plan[\s\S]*?<a href="\/admin\/o\/eagles\/billing"[^>]*>Upgrade to Pro<\/a>[\s\S]*?Sign out/);
    expect(orgHeader(html)).toContain("Eagles Club");
    expect(orgHeader(html)).toContain(">Owner<");
    expect(orgHeader(html)).not.toMatch(/Free Plan|Upgrade to Pro/);
    expect(count(html, "Free Plan")).toBe(1); // one place only (desktop profile; the mobile one lives in the closed More sheet)
    expect(count(html, "Upgrade to Pro")).toBe(1);
    expect(mobileHeader(html)).not.toMatch(/Free Plan|Upgrade/);
    expect(profile(html)).not.toMatch(/Account owner/);
    expect(sidebar(html)).toMatch(/<a href="\/admin\/o\/eagles\/billing"[^>]*>[\s\S]*?Billing &amp; Plan<\/a>/);
    expect(html).not.toMatch(/checkout/i);
  });

  it("every organization page shows the plan once, in the profile (overview, groups, group pages, settings, billing)", () => {
    const d = data({ organizations: [org("OWNER", P("TRIAL", { trialDaysLeft: 30 }))], billingEnabled: true });
    for (const p of ["/admin/o/eagles", "/admin/o/eagles/groups", "/admin/o/eagles/billing", "/admin/o/eagles/g/indoor", "/admin/o/eagles/g/indoor/players", "/admin/o/eagles/g/indoor/matches/m1", "/admin/o/eagles/g/indoor/settings"]) {
      const html = render(p, d);
      expect(profile(html), p).toMatch(/Owner · Eagles Club[\s\S]*?Pro Trial · 30 days left[\s\S]*?<a href="\/admin\/o\/eagles\/billing"[^>]*>Choose Pro Plan<\/a>/);
      expect(count(html, "Pro Trial · 30 days left"), p).toBe(1);
      expect(orgHeader(html), p).not.toContain("Pro Trial");
      expect(mobileHeader(html), p).not.toContain("Pro Trial");
    }
  });

  it("no organization selected (/admin, /me, plain Account Settings): the profile shows name + email, never an organization's plan", () => {
    const d = data({ organizations: [org("OWNER", P("TRIAL", { trialDaysLeft: 30 })), { ...ORGS[1], slug: "hawks", role: "OWNER", plan: P("LEGACY") }], billingEnabled: true });
    for (const p of ["/admin", "/me", "/account/security"]) {
      const html = render(p, d);
      expect(profile(html), p).toMatch(/Pat Organizer[\s\S]*?pat@example\.com/);
      expect(html, p).not.toMatch(/Pro Trial|Early Access|Choose Pro Plan|Upgrade to Pro|Plan: /);
    }
  });

  it("ADMIN: the plan and the read-only Billing & Plan link, never a purchase action", () => {
    const html = render("/admin/o/eagles/g/indoor", data({ organizations: [org("ADMIN", P("FREE"))], billingEnabled: true }));
    expect(sidebar(html)).toContain("Free Plan");
    expect(sidebar(html)).toContain(">Billing &amp; Plan<");
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Choose Pro Plan");
  });

  it("MEMBER: no plan, no Billing & Plan, no purchase action", () => {
    const html = render("/admin/o/eagles/g/indoor", data({ organizations: [org("MEMBER", null)], billingEnabled: true }));
    expect(html).not.toContain("Plan: ");
    expect(html).not.toContain("/admin/o/eagles/billing");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("paid Pro (monthly / yearly / unknown), Early Access and complimentary Pro: status only, no upgrade action", () => {
    for (const [plan, label] of [[P("PRO", { interval: "month" }), "Pro · Monthly"], [P("PRO", { interval: "year" }), "Pro · Yearly"], [P("PRO"), "Pro Plan"], [P("LEGACY"), "Early Access"], [P("COMP"), "Complimentary Pro"]] as const) {
      const html = render("/admin/o/eagles/g/indoor", data({ organizations: [org("OWNER", plan)], billingEnabled: true }));
      expect(sidebar(html), label).toContain(label);
      expect(html, label).not.toContain("Upgrade to Pro");
      expect(html, label).not.toContain("Choose Pro Plan");
      expect(sidebar(html), label).toContain(">Billing &amp; Plan<"); // still reachable
    }
  });

  it("switching organizations: each shows its own plan and its own Billing URL — never the other's", () => {
    const d = data({ organizations: [org("OWNER", P("FREE"), "eagles"), { slug: "hawks", name: "Hawks", role: "OWNER", groups: [{ slug: "sun", name: "Sunday", sportLabel: "Soccer" }], plan: P("PRO", { interval: "year" }) }], billingEnabled: true });
    const a = sidebar(render("/admin/o/eagles/g/indoor", d));
    const b = sidebar(render("/admin/o/hawks/g/sun", d));
    expect(a).toContain("Free Plan");
    expect(a).not.toContain("Pro · Yearly");
    expect(a).not.toContain("/admin/o/hawks/billing");
    expect(b).toContain("Pro · Yearly");
    expect(b).not.toContain("Free Plan");
    expect(b).toContain('href="/admin/o/hawks/billing"');
    expect(b).not.toContain("/admin/o/eagles/billing");
  });

  it("billing off: the plan is shown, no purchase action", () => {
    const html = render("/admin/o/eagles", data({ organizations: [org("OWNER", P("FREE"))], billingEnabled: false }));
    expect(sidebar(html)).toContain("Free Plan");
    expect(html).not.toContain("Upgrade to Pro");
  });

  it("shell data: plans are queried only for OWNER/ADMIN organizations; MEMBER organizations never get one", async () => {
    const user = { id: "u1", email: "pat@example.com", name: "Pat", emailVerifiedAt: new Date() };
    const m = (slug: string, role: string) => ({ role, organization: { id: slug, name: slug, slug, groups: [] } });
    const findMany = vi.fn(async () => [{ id: "own", plan: "FREE", trialEndsAt: null, billingSubscriptions: [] }]);
    const d = {
      user: { findUnique: vi.fn(async () => user) },
      organizationMembership: { findMany: vi.fn(async () => [m("own", "OWNER"), m("mem", "MEMBER")]) },
      player: { count: vi.fn(async () => 0) },
      organization: { findMany },
    } as unknown as ShellDataSource;
    const out = await loadShellDataFor({ email: "pat@example.com", id: "u1" }, d);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["own"] } } }));
    expect(out?.organizations.find((o) => o.slug === "own")?.plan).toEqual(P("FREE"));
    expect(out?.organizations.find((o) => o.slug === "mem")).not.toHaveProperty("plan");
  });
});
