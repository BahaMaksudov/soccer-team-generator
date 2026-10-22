import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/appShell";
import { ownershipAllowance, ownershipCountLabel, ownershipLimitMessage, SECOND_ORGANIZATION_NOTE, type OwnershipAllowance } from "@/lib/entitlements";
import { listAccessibleTenants, requireSessionUser, TenantContextError, type AccessibleOrganization } from "@/lib/tenantContext";

/**
 * Phase 3 — "My Organizations": where every sign-in lands (DEFAULT_AFTER_LOGIN)
 * and step one of Login → Organization → Group → Group dashboard.
 *
 * Lists exactly the session User's own memberships (listAccessibleTenants:
 * owned AND invited ADMIN/MEMBER organizations, each with the real role).
 * Selecting one opens its "My Groups" page. Never auto-selects (no
 * "first Organization"/"first Group" guess; a deep link to an authorized
 * page still opens that page directly). A User without an Organization gets
 * a welcome and "Create your first organization" (Phase 1 ownership rules
 * decide whether creation is available — invited memberships never count).
 */
export default async function AdminEntryPage() {
  let organizations: AccessibleOrganization[];
  let allowance: OwnershipAllowance;
  try {
    organizations = await listAccessibleTenants();
    // Phase 1 — display only; POST /api/admin/organizations enforces the allowance.
    allowance = await ownershipAllowance((await requireSessionUser()).id);
  } catch (e) {
    // Middleware already requires a session to reach this page; a
    // session that no longer maps to a User (e.g. deleted, or bound to
    // a different User.id) is sent back to sign in — fail closed.
    if (e instanceof TenantContextError) {
      redirect(e.code === "EMAIL_NOT_VERIFIED" ? "/verify-email" : "/login?callbackUrl=%2Fadmin");
    }
    throw e;
  }

  if (organizations.length === 0) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-6 text-center">
        <p className="eyebrow">Welcome</p>
        <h1 className="text-3xl font-extrabold">My Organizations</h1>
        <p className="text-muted-foreground">
          Welcome to TeamBalance Pro! An organization holds your groups — each group has its own players, matches and sport. If someone invited you, accept the invitation from your email to join their organization.
        </p>
        {allowance.canCreate ? (
          <Button asChild size="lg">
            <Link href="/onboarding">
              <Plus aria-hidden="true" />
              Create your first organization
            </Link>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{ownershipLimitMessage(allowance)}</p>
        )}
      </div>
    );
  }

  const orgGroupsHref = (org: AccessibleOrganization) => `/admin/o/${encodeURIComponent(org.slug)}/groups`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Organizations</p>
          <h1 className="mt-1 text-3xl font-extrabold">My Organizations</h1>
          <p className="mt-1 text-muted-foreground">Choose an organization to see its groups.</p>
        </div>
        {allowance.canCreate && (
          <Button asChild variant="outline">
            <Link href="/onboarding">
              <Plus aria-hidden="true" />
              Create organization
            </Link>
          </Button>
        )}
      </div>

      <ul className="grid gap-4 md:grid-cols-2" aria-label="Your organizations">
        {organizations.map((org) => (
          <li key={org.id}>
            <Link
              href={orgGroupsHref(org)}
              className="flex min-h-20 items-center gap-3 rounded-tbp-2xl border border-border bg-card p-4 shadow-card transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-tbp-sm bg-accent font-display font-black text-accent-foreground" aria-hidden="true">
                {org.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-lg font-extrabold">{org.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="secondary">{ROLE_LABELS[org.role]}</Badge>
                  {org.groups.length} {org.groups.length === 1 ? "group" : "groups"}
                </span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>

      {/* Phase 1 — ownership allowance: why another Organization can or can't be created. */}
      <section aria-labelledby="ownership-heading" className="rounded-tbp-xl border border-border bg-card p-4 text-sm">
        <h2 id="ownership-heading" className="font-semibold">
          {ownershipCountLabel(allowance)}
        </h2>
        <p className="mt-1 text-muted-foreground">{allowance.canCreate ? (allowance.owned > 0 ? SECOND_ORGANIZATION_NOTE : null) : ownershipLimitMessage(allowance)}</p>
      </section>
    </div>
  );
}
