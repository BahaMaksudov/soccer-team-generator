import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight, Building2, Layers, Users } from "lucide-react";
import { hasOrgRole, requireOrganizationContextForSlug, TenantContextError, type OrganizationContext } from "@/lib/tenantContext";
import { loadOrganizationGroups } from "@/lib/organizationGroups";
import { listOrganizationMembers } from "@/lib/invitations";
import { ROLE_LABELS } from "@/lib/appShell";
import { cn } from "@/lib/cn";
import { planSummary } from "@/lib/entitlements";
import PlanUsageCard from "./PlanUsageCard";

/**
 * UI-6 — Organization overview for ANY member (Organization from the URL slug,
 * verified against the session User's membership; generic 404 otherwise).
 * Real data only: name, your role, the active Groups. Members & invitations
 * remain OWNER-only (the existing M5 page; listOrganizationMembers enforces
 * OWNER server-side) — other roles see a note, not the data. There is no
 * rename / archive. M11.1 — OWNER/ADMIN see the read-only plan & usage card
 * (billing controls arrive with Stripe).
 */
type Params = Promise<{ organizationSlug: string }>;

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export default async function OrganizationPage({ params }: { params: Params }) {
  const { organizationSlug } = await params;
  let context: OrganizationContext;
  try {
    context = await requireOrganizationContextForSlug({ organizationSlug });
  } catch (e) {
    if (e instanceof TenantContextError) {
      if (e.code === "EMAIL_NOT_VERIFIED") redirect("/verify-email");
      notFound();
    }
    throw e;
  }
  const isOwner = hasOrgRole(context, ["OWNER"]);
  // M11.1 — plan & usage for OWNER/ADMIN only (MEMBERs never see it).
  const canSeePlan = hasOrgRole(context, ["OWNER", "ADMIN"]);
  const [{ groups }, members, plan] = await Promise.all([
    loadOrganizationGroups(context),
    isOwner ? listOrganizationMembers(context) : Promise.resolve(null),
    canSeePlan ? planSummary(context.organization.id) : Promise.resolve(null),
  ]);
  const base = `/admin/o/${encodeURIComponent(context.organization.slug)}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Organization</p>
          <h1 className="mt-1 truncate text-3xl font-extrabold">{context.organization.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Your role: {ROLE_LABELS[context.membership.role]}</p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="org-groups" className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
          <h2 id="org-groups" className="flex items-center gap-2 text-lg font-extrabold">
            <Layers className="size-5 text-primary" aria-hidden="true" /> Groups
          </h2>
          {groups.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No active groups yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {groups.map((g) => (
                <li key={g.slug} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                  <Link href={g.href} className={cn("min-w-0 truncate font-semibold hover:underline", focusRing)}>
                    {g.name}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{g.sportLabel}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href={`${base}/groups`} className={cn("mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline", focusRing)}>
            All groups <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </section>

        <section aria-labelledby="org-members" className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
          <h2 id="org-members" className="flex items-center gap-2 text-lg font-extrabold">
            <Users className="size-5 text-primary" aria-hidden="true" /> Members
          </h2>
          {members ? (
            <>
              <p className="mt-2 text-sm">
                {members.members.length} {members.members.length === 1 ? "member" : "members"} · {members.pendingInvitations.length} pending{" "}
                {members.pendingInvitations.length === 1 ? "invitation" : "invitations"}
              </p>
              <Link href={`${base}/members`} className={cn("mt-4 inline-flex min-h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90", focusRing)}>
                Manage members &amp; invitations
              </Link>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">The organization&apos;s owners manage members and invitations.</p>
          )}
        </section>
      </div>

      {plan && <PlanUsageCard summary={plan} />}

      <section aria-labelledby="org-details" className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <h2 id="org-details" className="flex items-center gap-2 text-lg font-extrabold">
          <Building2 className="size-5 text-primary" aria-hidden="true" /> Details
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Name</dt>
            <dd className="mt-0.5 font-semibold">{context.organization.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Active groups</dt>
            <dd className="mt-0.5 font-semibold">{groups.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Your role</dt>
            <dd className="mt-0.5 font-semibold">{ROLE_LABELS[context.membership.role]}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
