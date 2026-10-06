import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { prisma } from "@/lib/prisma";
import { findSport } from "@/lib/sports";
import { resolveAdminEntry } from "@/app/admin/adminEntry";
import { listAccessibleTenantsForEmail, resolveSessionAccount, TenantContextError, type TenantDataSource } from "@/lib/tenantContext";
import type { ShellData } from "@/lib/appShell";

/**
 * UI-3 — server-side data for the authenticated shell. READ-ONLY.
 *
 * Identity comes only from the NextAuth session, resolved to the User row
 * exactly like every page (resolveSessionAccount: email + bound User.id).
 * Organizations/Groups come only from that User's OWN OrganizationMembership
 * rows (listAccessibleTenantsForEmail — the same resolver /admin uses), and
 * only for a verified account (the central rule in tenantContext). No query
 * parameter, cookie, header or client value selects a tenant here.
 *
 * Returns null without a resolvable account: the layout then renders the page
 * alone and the page's own auth handling (redirect to /login etc.) applies.
 */
export type ShellDataSource = Pick<TenantDataSource, "user" | "organizationMembership"> & {
  player: { count(args: { where: { userId: string; group: { isActive: true } } }): Promise<number> };
};

export async function loadShellDataFor(
  session: { email?: string | null; id?: string | null } | null | undefined,
  db: ShellDataSource
): Promise<ShellData | null> {
  let account;
  try {
    account = await resolveSessionAccount({ email: session?.email, userId: session?.id }, db);
  } catch (e) {
    if (e instanceof TenantContextError) return null;
    throw e;
  }

  const tenants = account.emailVerified ? await listAccessibleTenantsForEmail(account.email, db, account.id) : [];
  const organizations = tenants.map((t) => ({
    slug: t.slug,
    name: t.name,
    role: t.role,
    groups: t.groups.map((g) => ({ slug: g.slug, name: g.name, sportLabel: findSport(g.sportKey)?.label ?? g.sportKey })),
  }));
  const hasPlayerProfile = account.emailVerified ? (await db.player.count({ where: { userId: account.id, group: { isActive: true } } })) > 0 : false;

  return {
    user: { name: account.name, email: account.email },
    organizations,
    hasPlayerProfile,
    workspaceListAvailable: tenants.length > 0 && resolveAdminEntry(tenants).kind !== "redirect",
  };
}

export async function loadShellData(): Promise<ShellData | null> {
  const session = await getServerSession(authOptions);
  return loadShellDataFor(session?.user, prisma as unknown as ShellDataSource);
}
