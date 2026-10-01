import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "./data";
import CanonicalAdminWorkspace from "./CanonicalAdminWorkspace";

/**
 * Phase 2D.6C — canonical tenant Admin entry point. Originally a
 * tenant-resolution checkpoint only; Phase 2D.6D.1 added Players,
 * Phase 2D.6D.2 added Generate (preview-only) — both tenant-bound to
 * the canonical API via CanonicalAdminWorkspace; later 2D.6D phases
 * added Publish, Settings, and Telegram the same way. Neither this
 * page nor the workspace calls any flat `/api/admin/*` route (those
 * were deleted in Phase 2D.6D.5E.5) — every request is URL-bound to
 * this one Group via adminTenantApiPath(...).
 *
 * Organization/Group names displayed, and the slugs passed to
 * CanonicalAdminWorkspace, come from the resolved TenantContext —
 * never echoed directly from the raw URL params.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function CanonicalAdminHome({ params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const context = await loadCanonicalAdminContext({ organizationSlug, groupSlug });
  if (!context) notFound();

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <div className="flex gap-3 text-sm">
          {context.membership.role === "OWNER" && (
            <Link className="underline" href={`/admin/o/${encodeURIComponent(context.organization.slug)}/members`}>
              Members
            </Link>
          )}
          <Link className="underline" href="/admin">
            Switch workspace
          </Link>
          <Link className="underline" href="/account/security">
            Account
          </Link>
        </div>
      </div>
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

      <CanonicalAdminWorkspace
        organizationSlug={context.organization.slug}
        groupSlug={context.activeGroup.slug}
      />
    </div>
  );
}
