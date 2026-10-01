import { redirect } from "next/navigation";
import { findSport } from "@/lib/sports";
import Link from "next/link";
import { listAccessibleTenants, TenantContextError, type AccessibleOrganization } from "@/lib/tenantContext";
import { resolveAdminEntry } from "./adminEntry";

/**
 * Phase 2D.6C — bare `/admin` is now the authenticated tenant-entry
 * point, not the operational application. The generator UI (formerly
 * here) now lives only in the canonical tenant-bound workspace
 * (/admin/o/[organizationSlug]/g/[groupSlug]); the legacy copy was
 * retired in Phase 2D.6D.5E.4 and deleted in 2D.6D.5E.5.
 *
 * Uses listAccessibleTenants() (Phase 2D.6B) — never the public
 * DEFAULT_PUBLIC_ORGANIZATION_SLUG/DEFAULT_PUBLIC_GROUP_SLUG
 * compatibility config, never a "first Organization"/"first Group"
 * query. The only case that auto-redirects is the objectively
 * unambiguous one; see ./adminEntry.ts for the exact decision rule.
 */
export default async function AdminEntryPage() {
  let organizations: AccessibleOrganization[];
  try {
    organizations = await listAccessibleTenants();
  } catch (e) {
    // Middleware already requires a session to reach this page; a
    // session that no longer maps to a User (e.g. deleted, or bound to
    // a different User.id) is sent back to sign in — fail closed.
    if (e instanceof TenantContextError) {
      redirect(e.code === "EMAIL_NOT_VERIFIED" ? "/verify-email" : "/login?callbackUrl=%2Fadmin");
    }
    throw e;
  }

  const entry = resolveAdminEntry(organizations);

  if (entry.kind === "redirect") {
    redirect(entry.href);
  }

  // M5: a signed-in User with no Organization yet starts onboarding.
  if (entry.kind === "no-access") {
    redirect("/onboarding");
  }

  const shown = entry.kind === "select" ? entry.organizations : [entry.organization];

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Your workspaces</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link className="text-sm underline" href="/me">
            My teams
          </Link>
          <Link className="text-sm underline" href="/account/security">
            Account
          </Link>
          <Link className="text-sm rounded-md border px-3 py-1.5 hover:bg-gray-50" href="/onboarding">
            Create organization
          </Link>
        </div>
      </div>
      {shown.map((org) => (
        <div key={org.id} className="border rounded-xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">
              {org.name} <span className="text-xs text-gray-500 font-normal">({org.role})</span>
            </div>
            <div className="flex gap-3">
              {(org.role === "OWNER" || org.role === "ADMIN") && (
                <Link className="text-sm underline" href={`/admin/o/${encodeURIComponent(org.slug)}/groups/new`}>
                  Add group
                </Link>
              )}
              {org.role === "OWNER" && (
                <Link className="text-sm underline" href={`/admin/o/${encodeURIComponent(org.slug)}/members`}>
                  Members
                </Link>
              )}
            </div>
          </div>
          {org.groups.length === 0 ? (
            <div className="text-sm text-gray-500 mt-2">No active groups.</div>
          ) : (
            <ul className="mt-2 space-y-1">
              {org.groups.map((g) => (
                <li key={g.id}>
                  <Link
                    className="text-sm underline"
                    href={`/admin/o/${encodeURIComponent(org.slug)}/g/${encodeURIComponent(g.slug)}`}
                  >
                    {g.name} ({findSport(g.sportKey)?.label ?? g.sportKey})
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
