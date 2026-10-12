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
};

export type ShellContext = { organization: ShellOrganization; group: ShellGroup | null } | null;

export type NavKey =
  | "overview"
  | "players"
  | "matches"
  | "group-settings"
  | "all-groups"
  | "groups"
  | "organization"
  | "members"
  | "billing"
  | "organizations"
  | "my-games"
  | "account";
/**
 * Phase 3 — the sidebar follows Login → Organization → Group:
 *   group         the selected Group's pages (state C)
 *   organization  the selected Organization's pages (state B)
 *   navigate      way back up the hierarchy: All Groups / All Organizations / My Organizations
 *   account       personal: My Games (claimed Player), Account Settings
 */
export type NavSection = "group" | "organization" | "navigate" | "account";
export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  group: "Group",
  organization: "Organization",
  navigate: "",
  account: "Account",
};
export const NAV_SECTION_ORDER: readonly NavSection[] = ["group", "organization", "navigate", "account"];
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
 * Phase 3.1 — Account Settings keeps the sidebar context of the page it was
 * opened from, carried in its URL (`/account/security?o=<org>&g=<group>`) so
 * refresh, bookmarks and Back/Forward keep it. Presentation only: the slugs are
 * resolved exactly like an /admin URL — ONLY against the server-authorized
 * memberships in ShellData (unknown / foreign / malformed → no context). The
 * Account page itself never reads them; nothing is authorized by them.
 */
export const ACCOUNT_SETTINGS_PATH = "/account/security";
const CONTEXT_PARAM_MAX = 200;
type SearchLike = { get(name: string): string | null } | null | undefined;

/** The navigation context of a location: the /admin path itself, or (Account pages only) the ?o=&g= it carries. */
export function shellContextFromLocation(pathname: string | null | undefined, search: SearchLike, organizations: ShellOrganization[]): ShellContext {
  if (!pathname?.startsWith("/account/")) return shellContextFromPath(pathname, organizations);
  const o = search?.get("o") ?? "";
  const g = search?.get("g") ?? "";
  if (!o || o.length > CONTEXT_PARAM_MAX || g.length > CONTEXT_PARAM_MAX) return null;
  return shellContextFromPath(g ? groupAdminHref(o, g) : organizationHref(o), organizations);
}

/** Account Settings, carrying the current Organization/Group context (none → the plain page). */
export function accountSettingsHref(ctx: ShellContext): string {
  if (!ctx) return ACCOUNT_SETTINGS_PATH;
  const q = new URLSearchParams({ o: ctx.organization.slug, ...(ctx.group ? { g: ctx.group.slug } : {}) });
  return `${ACCOUNT_SETTINGS_PATH}?${q.toString()}`;
}

/**
 * Phase 3 — context-sensitive navigation (presentation only — every page re-checks access):
 *   A  no Organization selected   My Organizations
 *   B  Organization selected       My Groups, Organization Overview (any member);
 *                                  Members & Invitations (OWNER); Billing & Plan (OWNER/ADMIN);
 *                                  All Organizations
 *   C  Group selected              Overview, Players, Matches (any member); Group Settings
 *                                  (OWNER/ADMIN); All Groups — no Organization management links
 *   always                         My Games (claimed Player), Account Settings (+ Sign Out in the shell)
 * Switching Groups happens only in the group switcher, within the selected Organization.
 */
export function buildShellNav(params: { data: ShellData; pathname: string; hash?: string; search?: SearchLike }): NavItem[] {
  const { data, pathname } = params;
  const ctx = shellContextFromLocation(pathname, params.search, data.organizations);
  const items: NavItem[] = [];
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);

  if (ctx) {
    const org = ctx.organization;
    const manager = org.role === "OWNER" || org.role === "ADMIN";
    const groups = groupsHrefOf(org.slug);
    if (ctx.group) {
      // State C — the selected Group.
      const base = groupAdminHref(org.slug, ctx.group.slug);
      const settings = groupSettingsHref(org.slug, ctx.group.slug);
      items.push(
        { key: "overview", label: "Overview", href: base, active: pathname === base || pathname === `${base}/`, section: "group", mobilePrimary: true },
        { key: "players", label: "Players", href: `${base}/players`, active: under(`${base}/players`), section: "group", mobilePrimary: true },
        { key: "matches", label: "Matches", href: `${base}/matches`, active: under(`${base}/matches`), section: "group", mobilePrimary: true }
      );
      if (manager) items.push({ key: "group-settings", label: "Group Settings", href: settings, active: under(settings), section: "group", mobilePrimary: false });
      items.push({ key: "all-groups", label: "All Groups", href: groups, active: false, section: "navigate", mobilePrimary: false });
    } else {
      // State B — the selected Organization.
      const overview = organizationHref(org.slug);
      items.push(
        { key: "groups", label: "My Groups", href: groups, active: under(groups), section: "organization", mobilePrimary: true },
        { key: "organization", label: "Organization Overview", href: overview, active: pathname === overview || pathname === `${overview}/`, section: "organization", mobilePrimary: true }
      );
      if (org.role === "OWNER") items.push({ key: "members", label: "Members & Invitations", href: membersHref(org.slug), active: under(membersHref(org.slug)), section: "organization", mobilePrimary: false });
      if (manager) items.push({ key: "billing", label: "Billing & Plan", href: billingHrefOf(org.slug), active: under(billingHrefOf(org.slug)), section: "organization", mobilePrimary: false });
      items.push({ key: "organizations", label: "All Organizations", href: "/admin", active: false, section: "navigate", mobilePrimary: true });
    }
  } else {
    // State A — choose an Organization (also the welcome page for a User without one).
    items.push({ key: "organizations", label: "My Organizations", href: "/admin", active: pathname === "/admin" || pathname === "/admin/", section: "navigate", mobilePrimary: true });
  }

  if (data.hasPlayerProfile || under("/me")) {
    items.push({ key: "my-games", label: "My Games", href: "/me", active: under("/me"), section: "account", mobilePrimary: true });
  }
  items.push({ key: "account", label: "Account Settings", href: accountSettingsHref(ctx), active: pathname.startsWith("/account/"), section: "account", mobilePrimary: false });
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
