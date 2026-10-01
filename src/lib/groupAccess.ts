import { prisma } from "@/lib/prisma";
import { requireSessionUser, TenantContextError } from "@/lib/tenantContext";
import { resolvePublicGroup, type PublicGroupContext } from "@/lib/publicGroup";

/**
 * Who may view a NON-PUBLIC (LINK or PRIVATE) Group through its slug URL
 * (/g/[org]/[group] pages and /api/public/[org]/[group]/*). Re-checked in
 * the database on every request; never from cookies/localStorage/session
 * claims. The viewer must be a signed-in, email-verified User who is
 * either:
 *   - an organizer: OrganizationMembership in the Group's Organization
 *     (M6-A), or
 *   - a claimed Player of THAT Group: Player.userId = User.id and
 *     Player.groupId = Group.id (M6-C).
 * This only decides PLAYER-FACING viewing. A claimed Player never gains
 * organizer access — every Admin page/API still requires
 * OrganizationMembership (src/lib/tenantContext.ts). Anonymous viewers of
 * LINK Groups use share links instead (src/lib/shareLinks.ts).
 */
export async function viewerCanViewGroup(organizationId: string, groupId: string): Promise<boolean> {
  try {
    const user = await requireSessionUser();
    const [membership, claimed] = await Promise.all([
      prisma.organizationMembership.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId } },
        select: { id: true },
      }),
      prisma.player.findFirst({ where: { groupId, userId: user.id }, select: { id: true } }),
    ]);
    return membership !== null || claimed !== null;
  } catch (e) {
    if (e instanceof TenantContextError) return false;
    throw e;
  }
}

/** resolvePublicGroup() with organizer / claimed-player access to non-PUBLIC Groups. */
export function resolveGroupForViewer(params: { organizationSlug: string; groupSlug: string }): Promise<PublicGroupContext | null> {
  return resolvePublicGroup(params, prisma, { canViewNonPublic: viewerCanViewGroup });
}
