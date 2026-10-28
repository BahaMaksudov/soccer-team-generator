import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { prisma } from "@/lib/prisma";
import { findSport } from "@/lib/sports";
import { listAccessibleTenantsForEmail, resolveSessionAccount, TenantContextError, type TenantDataSource } from "@/lib/tenantContext";
import type { ShellData, ShellPlan } from "@/lib/appShell";
import { effectivePlan, trialDaysLeft } from "@/lib/entitlements";
import { ENTITLING_STATUSES } from "@/lib/billing/sync";
import { billingConfig } from "@/lib/billing/config";

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
type PlanRow = { id: string; plan: "FREE" | "PRO" | "COMP" | "LEGACY"; trialEndsAt: Date | null; billingSubscriptions: Array<{ interval: string | null }> };
export type ShellDataSource = Pick<TenantDataSource, "user" | "organizationMembership"> & {
  player: { count(args: { where: { userId: string; group: { isActive: true } } }): Promise<number> };
  organization: { findMany(args: unknown): Promise<PlanRow[]> };
};

const intervalOf = (v: string | null | undefined): ShellPlan["interval"] => (v === "month" || v === "year" ? v : null);

/**
 * The sidebar plan indicator, from the same rules the server enforces (effectivePlan,
 * trialDaysLeft). The interval is read only from an ENTITLING subscription; unknown → null.
 */
export function shellPlanOf(row: PlanRow, now: Date = new Date()): ShellPlan {
  const kind = effectivePlan(row, now);
  return {
    kind,
    trialDaysLeft: kind === "TRIAL" ? trialDaysLeft(row.trialEndsAt, now) : null,
    interval: kind === "PRO" ? intervalOf(row.billingSubscriptions[0]?.interval) : null,
  };
}

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
  // Plans only for the Organizations this User manages (OWNER/ADMIN) — the roles that may open Billing & Plan.
  const managed = tenants.filter((t) => t.role === "OWNER" || t.role === "ADMIN").map((t) => t.id);
  const planRows = managed.length
    ? await db.organization.findMany({
        where: { id: { in: managed } },
        select: { id: true, plan: true, trialEndsAt: true, billingSubscriptions: { where: { status: { in: [...ENTITLING_STATUSES] } }, orderBy: { updatedAt: "desc" }, take: 1, select: { interval: true } } },
      })
    : [];
  const now = new Date();
  const plans = new Map(planRows.map((r) => [r.id, shellPlanOf(r, now)]));
  const organizations = tenants.map((t) => ({
    slug: t.slug,
    name: t.name,
    role: t.role,
    groups: t.groups.map((g) => ({ slug: g.slug, name: g.name, sportLabel: findSport(g.sportKey)?.label ?? g.sportKey })),
    ...(plans.has(t.id) ? { plan: plans.get(t.id)! } : {}),
  }));
  const hasPlayerProfile = account.emailVerified ? (await db.player.count({ where: { userId: account.id, group: { isActive: true } } })) > 0 : false;

  return {
    user: { name: account.name, email: account.email },
    organizations,
    hasPlayerProfile,
    billingEnabled: billingConfig().enabled,
  };
}

export async function loadShellData(): Promise<ShellData | null> {
  const session = await getServerSession(authOptions);
  return loadShellDataFor(session?.user, prisma as unknown as ShellDataSource);
}
