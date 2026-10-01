import { prisma } from "@/lib/prisma";
import { resolvePublicGroup, type PublicGroupContext } from "@/lib/publicGroup";
import { viewerIsOrganizationMember } from "@/lib/groupAccess";

/**
 * Phase 2D.5D — subtree-wide resolver gate for every canonical
 * /g/[organizationSlug]/[groupSlug]/* route. Same thin-wrapper pattern
 * as players/data.ts (Phase 2D.5C): a plain .ts module so the gating
 * logic is unit-testable without a JSX transform.
 *
 * Deliberately independent of each page's own resolution (home's
 * data.ts, players/data.ts) — per Phase 2D.5D §11, duplicate
 * deterministic reads are accepted here rather than introducing
 * shared mutable request-scoped caching. This gate exists so the
 * WHOLE subtree 404s consistently (including future routes added
 * under /g/.../* in later phases) even before a specific page's own
 * data-loading runs.
 */
export async function loadPublicGroupLayoutData(params: {
  organizationSlug: string;
  groupSlug: string;
}): Promise<{ publicGroup: PublicGroupContext } | null> {
  const publicGroup = await resolvePublicGroup(
    { organizationSlug: params.organizationSlug, groupSlug: params.groupSlug },
    prisma,
    // M6-A: non-PUBLIC Groups only for their organizers (fails closed otherwise).
    { canViewNonPublic: viewerIsOrganizationMember }
  );
  if (!publicGroup) return null;

  return { publicGroup };
}
