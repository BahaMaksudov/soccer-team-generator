import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePublicGroup } from "@/lib/publicGroup";

/**
 * Phase 2D.5C — canonical tenant-scoped public Players API.
 *
 * Read-only. Tenant identity comes only from the URL's two slug
 * segments, resolved through resolvePublicGroup() — the same
 * session-free resolver the canonical home route uses. Never accepts
 * a client-supplied groupId as ownership authority from any source
 * (query params, headers, body, cookies).
 *
 * DTO is deliberately narrower than the legacy /api/public/players:
 * the live public Players UI (players-client.tsx, both legacy and
 * this canonical version) renders only name/position/status — it
 * never displays a score, and rating/stamina are fetched by the
 * legacy route but never read by its client. Excluding them here
 * removes unnecessary exposure without changing any displayed
 * behavior. See Phase 2D.5C report §C/§D for the audit trail.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export async function GET(_req: Request, { params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const publicGroup = await resolvePublicGroup({ organizationSlug, groupSlug }, prisma);
  if (!publicGroup) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const players = await prisma.player.findMany({
    where: { groupId: publicGroup.group.id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      isActive: true,
    },
  });

  return NextResponse.json(players);
}
