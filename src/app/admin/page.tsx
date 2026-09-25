import { redirect } from "next/navigation";
import Link from "next/link";
import { listAccessibleTenants, TenantContextError, type AccessibleOrganization } from "@/lib/tenantContext";
import { resolveAdminEntry } from "./adminEntry";

/**
 * Phase 2D.6C — bare `/admin` is now the authenticated tenant-entry
 * point, not the operational application. The real generator UI
 * (formerly here) moved verbatim to
 * src/app/admin/components/AdminWorkspace.tsx and is not rendered by
 * anything yet — that migration is a later phase (2D.6D+).
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
    // Middleware already requires a session to reach this page at
    // all; a TenantContextError here (e.g. the tenant tables somehow
    // don't recognize this session) is treated as "no access" rather
    // than crashing — fail closed, not fail loud.
    if (e instanceof TenantContextError) {
      organizations = [];
    } else {
      throw e;
    }
  }

  const entry = resolveAdminEntry(organizations);

  if (entry.kind === "redirect") {
    redirect(entry.href);
  }

  if (entry.kind === "no-access") {
    return (
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <h1 className="text-2xl font-semibold mb-2">Admin</h1>
        <p className="text-gray-600">
          Your account does not currently have access to any organization. Contact an administrator.
        </p>
      </div>
    );
  }

  if (entry.kind === "no-active-groups") {
    return (
      <div className="rounded-2xl border bg-white shadow-sm p-5">
        <h1 className="text-2xl font-semibold mb-2">Admin</h1>
        <p className="text-gray-600">
          No active groups are currently available for {entry.organization.name}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-4">
      <h1 className="text-2xl font-semibold">Select a workspace</h1>
      {entry.organizations.map((org) => (
        <div key={org.id} className="border rounded-xl p-4">
          <div className="font-semibold">
            {org.name} <span className="text-xs text-gray-500 font-normal">({org.role})</span>
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
                    {g.name} ({g.sportKey})
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
