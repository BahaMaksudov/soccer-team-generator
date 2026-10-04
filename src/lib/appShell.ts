/**
 * UI-3 — authenticated application shell: pure navigation model.
 *
 * PRESENTATION ONLY. Every input comes from the server-authorized shell data
 * (src/lib/appShellData.ts: the session User's own OrganizationMemberships
 * and their active Groups) plus the current URL path. Nothing here grants
 * access: each linked page re-resolves the tenant from its URL and re-checks
 * membership server-side (src/lib/tenantContext.ts). A role only decides
 * which links are SHOWN; hiding a link never replaces a server check.
 *
 * Roles are the real OrgRole values: OWNER, ADMIN, MEMBER. Player identity
 * (a claimed Player.userId) only adds the personal "My Games" link and never
 * organizer navigation.
 */

export type ShellRole = "OWNER" | "ADMIN" | "MEMBER";

export type ShellGroup = { slug: string; name: string; sportLabel: string };
export type ShellOrganization = { slug: string; name: string; role: ShellRole; groups: ShellGroup[] };

export type ShellData = {
  user: { name: string | null; email: string };
  organizations: ShellOrganization[];
  /** The User has at least one claimed Player profile (Player.userId). */
  hasPlayerProfile: boolean;
  /** `/admin` lists workspaces (false when it would just redirect to the only Group). */
  workspaceListAvailable: boolean;
};

export type ShellContext = { organization: ShellOrganization; group: ShellGroup | null } | null;

export type NavKey = "overview" | "matches" | "players" | "groups" | "my-games" | "organization" | "account";
export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  active: boolean;
  section: "main" | "personal" | "admin";
  /** Shown in the mobile bottom bar (the rest go under "More"). */
  mobilePrimary: boolean;
};

/** Where Sign Out lands: a relative, same-origin path (never an absolute URL). */
export const SIGN_OUT_DESTINATION = "/login";

export const ROLE_LABELS: Record<ShellRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" };

const enc = encodeURIComponent;

export const groupAdminHref = (organizationSlug: string, groupSlug: string) => `/admin/o/${enc(organizationSlug)}/g/${enc(groupSlug)}`;
export const membersHref = (organizationSlug: string) => `/admin/o/${enc(organizationSlug)}/members`;

function decodeSegment(s: string | undefined): string | null {
  if (!s) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The Organization/Group the URL names — but ONLY if it is in the
 * server-authorized list. An unknown or foreign slug yields a neutral
 * (null) context; the page itself 404s it.
 */
export function shellContextFromPath(pathname: string | null | undefined, organizations: ShellOrganization[]): ShellContext {
  if (!pathname) return null;
  const m = /^\/admin\/o\/([^/]+)(?:\/g\/([^/]+))?(?:\/|$)/.exec(pathname);
  if (!m) return null;
  const orgSlug = decodeSegment(m[1]);
  const organization = organizations.find((o) => o.slug === orgSlug);
  if (!organization) return null;
  if (m[2] === undefined) return { organization, group: null };
  const groupSlug = decodeSegment(m[2]);
  const group = organization.groups.find((g) => g.slug === groupSlug);
  return group ? { organization, group } : null;
}

export function buildShellNav(params: { data: ShellData; pathname: string; hash?: string }): NavItem[] {
  const { data, pathname } = params;
  const hash = (params.hash ?? "").replace(/^#/, "");
  const ctx = shellContextFromPath(pathname, data.organizations);
  const items: NavItem[] = [];

  if (ctx?.group) {
    const base = groupAdminHref(ctx.organization.slug, ctx.group.slug);
    const onGroupPage = pathname === base || pathname === `${base}/`;
    const matchesBase = `${base}/matches`;
    const onMatches = pathname === matchesBase || pathname.startsWith(`${matchesBase}/`);
    // UI-4 — Matches is a real page (list + each Match workspace); Players is still a section of the Group page.
    items.push(
      { key: "overview", label: "Overview", href: base, active: onGroupPage && hash !== "players", section: "main", mobilePrimary: true },
      { key: "matches", label: "Matches", href: matchesBase, active: onMatches, section: "main", mobilePrimary: true },
      { key: "players", label: "Players", href: `${base}#players`, active: onGroupPage && hash === "players", section: "main", mobilePrimary: true }
    );
  }

  if (data.workspaceListAvailable) {
    items.push({ key: "groups", label: "Groups", href: "/admin", active: pathname === "/admin", section: "main", mobilePrimary: !ctx?.group });
  }

  if (data.hasPlayerProfile || pathname === "/me" || pathname.startsWith("/me/")) {
    items.push({ key: "my-games", label: "My Games", href: "/me", active: pathname === "/me" || pathname.startsWith("/me/"), section: "personal", mobilePrimary: true });
  }

  // Organization = the existing Members page, which is OWNER-only server-side.
  if (ctx && ctx.organization.role === "OWNER") {
    const href = membersHref(ctx.organization.slug);
    items.push({ key: "organization", label: "Organization", href, active: pathname === href, section: "admin", mobilePrimary: false });
  }

  items.push({ key: "account", label: "Account", href: "/account/security", active: pathname.startsWith("/account/"), section: "admin", mobilePrimary: false });
  return items;
}

/** Group switcher entries: every authorized active Group, by Organization, with canonical URLs. */
export function switcherEntries(organizations: ShellOrganization[], ctx: ShellContext) {
  return organizations.map((o) => ({
    organization: { slug: o.slug, name: o.name, roleLabel: ROLE_LABELS[o.role] },
    groups: o.groups.map((g) => ({
      ...g,
      href: groupAdminHref(o.slug, g.slug),
      current: ctx?.group != null && ctx.organization.slug === o.slug && ctx.group.slug === g.slug,
    })),
  }));
}

export function initialsOf(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
