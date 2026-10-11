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

export type NavKey =
  | "overview"
  | "matches"
  | "players"
  | "group-settings"
  | "organization"
  | "groups"
  | "members"
  | "billing"
  | "workspaces"
  | "my-games"
  | "account";
/** Account → Organization → Group: each navigation section is one level of that hierarchy. */
export type NavSection = "group" | "organization" | "workspaces" | "account";
export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  group: "Group Management",
  organization: "Organization Management",
  workspaces: "Workspaces",
  account: "Account Settings",
};
export const NAV_SECTION_ORDER: readonly NavSection[] = ["group", "organization", "workspaces", "account"];
export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  active: boolean;
  section: NavSection;
  /** Shown in the mobile bottom bar (the rest go under "More"). */
  mobilePrimary: boolean;
};

/** Where Sign Out lands: a relative, same-origin path (never an absolute URL). */
export const SIGN_OUT_DESTINATION = "/login";

export const ROLE_LABELS: Record<ShellRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" };

const enc = encodeURIComponent;

export const groupAdminHref = (organizationSlug: string, groupSlug: string) => `/admin/o/${enc(organizationSlug)}/g/${enc(groupSlug)}`;
export const membersHref = (organizationSlug: string) => `/admin/o/${enc(organizationSlug)}/members`;
export const organizationHref = (organizationSlug: string) => `/admin/o/${enc(organizationSlug)}`;
export const groupsHrefOf = (organizationSlug: string) => `/admin/o/${enc(organizationSlug)}/groups`;
export const billingHrefOf = (organizationSlug: string) => `/admin/o/${enc(organizationSlug)}/billing`;
export const groupSettingsHref = (organizationSlug: string, groupSlug: string) => `${groupAdminHref(organizationSlug, groupSlug)}/settings`;

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

/**
 * Role-aware navigation by level (presentation only — every page re-checks access):
 *   Group Management         Overview, Matches, Players (any member); Group Settings (OWNER/ADMIN)
 *   Organization Management  Organization Overview (any member); Manage Groups (OWNER/ADMIN — a
 *                            MEMBER sees the same list as "Groups"); Members & Invitations (OWNER);
 *                            Billing & Subscription (OWNER/ADMIN — ADMIN read-only)
 *   Workspaces               Your workspaces (/admin) when no Organization is selected
 *   Account Settings         My Games (claimed Player), Account settings
 * Group switching stays in the group switcher only (never duplicated here).
 */
export function buildShellNav(params: { data: ShellData; pathname: string; hash?: string }): NavItem[] {
  const { data, pathname } = params;
  const ctx = shellContextFromPath(pathname, data.organizations);
  const items: NavItem[] = [];
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  const manager = ctx ? ctx.organization.role === "OWNER" || ctx.organization.role === "ADMIN" : false;

  if (ctx?.group) {
    const base = groupAdminHref(ctx.organization.slug, ctx.group.slug);
    const settings = groupSettingsHref(ctx.organization.slug, ctx.group.slug);
    items.push(
      { key: "overview", label: "Overview", href: base, active: pathname === base || pathname === `${base}/`, section: "group", mobilePrimary: true },
      { key: "matches", label: "Matches", href: `${base}/matches`, active: under(`${base}/matches`), section: "group", mobilePrimary: true },
      { key: "players", label: "Players", href: `${base}/players`, active: under(`${base}/players`), section: "group", mobilePrimary: true }
    );
    if (manager) items.push({ key: "group-settings", label: "Group Settings", href: settings, active: under(settings), section: "group", mobilePrimary: false });
  }

  if (ctx) {
    const org = ctx.organization;
    const overview = organizationHref(org.slug);
    const onlyOrg = !ctx.group; // on Organization pages, its links lead the mobile bar
    items.push({ key: "organization", label: "Organization Overview", href: overview, active: pathname === overview || pathname === `${overview}/`, section: "organization", mobilePrimary: onlyOrg });
    items.push({ key: "groups", label: manager ? "Manage Groups" : "Groups", href: groupsHrefOf(org.slug), active: under(groupsHrefOf(org.slug)), section: "organization", mobilePrimary: onlyOrg });
    if (org.role === "OWNER") items.push({ key: "members", label: "Members & Invitations", href: membersHref(org.slug), active: under(membersHref(org.slug)), section: "organization", mobilePrimary: false });
    if (manager) items.push({ key: "billing", label: "Billing & Subscription", href: billingHrefOf(org.slug), active: under(billingHrefOf(org.slug)), section: "organization", mobilePrimary: onlyOrg });
  } else if (data.organizations.length > 0) {
    // No Organization selected (e.g. My Games, Account): a way back — /admin lists workspaces or opens the only Group.
    items.push({ key: "workspaces", label: "Your workspaces", href: "/admin", active: pathname === "/admin", section: "workspaces", mobilePrimary: true });
  }

  if (data.hasPlayerProfile || under("/me")) {
    items.push({ key: "my-games", label: "My Games", href: "/me", active: under("/me"), section: "account", mobilePrimary: true });
  }
  items.push({ key: "account", label: "Account settings", href: "/account/security", active: pathname.startsWith("/account/"), section: "account", mobilePrimary: false });
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
