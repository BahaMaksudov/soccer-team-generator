import { prisma } from "@/lib/prisma";
import { resolvePublicGroup, type PublicGroupContext } from "@/lib/publicGroup";

/**
 * Phase 2D.5B — data loading for the canonical public Group home page,
 * kept separate from page.tsx (a plain .ts module, not .tsx) so the
 * tenant-scoping logic is directly unit-testable without a JSX
 * transform — this repo's Vitest config has none, and no existing
 * test touches a .tsx file, so adding one would be a shared test-infra
 * change beyond this phase's footprint. The page component itself
 * stays untested, consistent with every other page.tsx in this repo.
 */

export type PublicGeneration = {
  id: string;
  date: Date;
  updatedAt: Date;
  teams: Array<{
    teamNumber: number;
    players: Array<{ id: string; firstName: string; lastName: string; position: string }>;
  }>;
};

export type PublicGroupHomeData = {
  publicGroup: PublicGroupContext;
  items: PublicGeneration[];
  page: number;
  totalPages: number;
};

const PAGE_SIZE = 4;

/**
 * Returns null when the URL's (organizationSlug, groupSlug) pair
 * doesn't resolve to a real, active Group — the caller (page.tsx)
 * must turn that into notFound(), never a redirect or a default
 * Group. Both the count and the row query are scoped to the resolved
 * Group's id; neither may ever run unscoped.
 */
export async function loadPublicGroupHomeData(params: {
  organizationSlug: string;
  groupSlug: string;
  page?: string;
}): Promise<PublicGroupHomeData | null> {
  const publicGroup = await resolvePublicGroup(
    { organizationSlug: params.organizationSlug, groupSlug: params.groupSlug },
    prisma
  );
  if (!publicGroup) return null;

  const page = Math.max(1, Number(params.page ?? "1"));

  const total = await prisma.teamGeneration.count({
    where: { groupId: publicGroup.group.id },
  });
  const totalPages = total === 0 ? 0 : Math.ceil(total / PAGE_SIZE);

  const rows = await prisma.teamGeneration.findMany({
    where: { groupId: publicGroup.group.id },
    orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: { id: true, date: true, updatedAt: true, teamsJson: true },
  });

  const items: PublicGeneration[] = rows.map((r) => ({
    id: r.id,
    date: r.date,
    updatedAt: r.updatedAt,
    teams: JSON.parse(r.teamsJson) as PublicGeneration["teams"],
  }));

  return { publicGroup, items, page, totalPages };
}
