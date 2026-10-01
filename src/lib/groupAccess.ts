import { prisma } from "@/lib/prisma";
import { requireSessionUser, TenantContextError } from "@/lib/tenantContext";
import { resolvePublicGroup, type PublicGroupContext } from "@/lib/publicGroup";

/**
 * M6-A — who may view a NON-PUBLIC Group through its slug URL
 * (/g/[org]/[group] pages and /api/public/[org]/[group]/*):
 * a signed-in, email-verified User with an OrganizationMembership in
 * that Group's Organization (re-checked in the database every request;
 * never from cookies/localStorage/session claims). Claimed-Player access
 * for PRIVATE Groups arrives in M6-C. Anonymous viewers of LINK Groups
 * use the share-link path instead (src/lib/shareLinks.ts).
 */
export async function viewerIsOrganizationMember(organizationId: string): Promise<boolean> {
  try {
    const user = await requireSessionUser();
    const membership = await prisma.organizationMembership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      select: { id: true },
    });
    return membership !== null;
  } catch (e) {
    if (e instanceof TenantContextError) return false;
    throw e;
  }
}

/** resolvePublicGroup() with organizer access to non-PUBLIC Groups. */
export function resolveGroupForViewer(params: { organizationSlug: string; groupSlug: string }): Promise<PublicGroupContext | null> {
  return resolvePublicGroup(params, prisma, { canViewNonPublic: viewerIsOrganizationMember });
}
