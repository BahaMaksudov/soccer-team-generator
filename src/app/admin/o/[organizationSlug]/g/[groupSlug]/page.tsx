import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "./data";
import CanonicalPlayersSection from "./CanonicalPlayersSection";

/**
 * Phase 2D.6C — canonical tenant Admin entry point. Originally a
 * tenant-resolution checkpoint only; Phase 2D.6D.1 adds the first
 * operational section (Players), tenant-bound to the canonical API.
 * It still renders no other operational actions and still calls no
 * OTHER flat `/api/admin/*` route (Generate/Publish/Settings/
 * Telegram remain on the old zero-argument requireTenantContext()
 * path and are not called from here) — calling them from a page that
 * displays one specific Group would risk silently operating on a
 * different Group if the old resolver ever diverged (Phase 2D.6C
 * report §17). Those migrate in later phases, not this one.
 *
 * Organization/Group names displayed, and the slugs passed to
 * CanonicalPlayersSection, come from the resolved TenantContext —
 * never echoed directly from the raw URL params.
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

      <CanonicalPlayersSection
        organizationSlug={context.organization.slug}
        groupSlug={context.activeGroup.slug}
      />
    </div>
  );
}
