import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "./data";

/**
 * Phase 2D.6C — canonical tenant Admin entry point. A tenant-
 * resolution checkpoint ONLY: it proves URL-bound authenticated
 * tenant resolution end-to-end in the real browser before any
 * operational feature migrates here. It deliberately renders no
 * operational actions and calls no flat `/api/admin/*` route — those
 * still resolve tenancy via the old zero-argument
 * requireTenantContext(), and calling them from a page that displays
 * one specific Group would risk silently operating on a different
 * Group if the old resolver ever diverged (Phase 2D.6C report §17).
 * That migration is Phase 2D.6D+, not this one.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function CanonicalAdminHome({ params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const context = await loadCanonicalAdminContext({ organizationSlug, groupSlug });
  if (!context) notFound();

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-2">
      <h1 className="text-2xl font-semibold mb-2">Admin</h1>
      <p>
        <span className="text-gray-500">Organization:</span> {context.organization.name}
      </p>
      <p>
        <span className="text-gray-500">Group:</span> {context.activeGroup.name}
      </p>
      <p>
        <span className="text-gray-500">Sport:</span> {context.activeGroup.sportKey}
      </p>
      <p>
        <span className="text-gray-500">Role:</span> {context.membership.role}
      </p>
      <p className="text-sm text-gray-600 pt-2">Tenant-scoped Admin workspace is ready.</p>
    </div>
  );
}
