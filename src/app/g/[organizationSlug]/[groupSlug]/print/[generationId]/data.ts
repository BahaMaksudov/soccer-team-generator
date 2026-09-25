import { prisma } from "@/lib/prisma";
import { resolvePublicGroup } from "@/lib/publicGroup";

/**
 * Phase 2D.5E — canonical, tenant-safe print data loader.
 *
 * Same split-out-of-.tsx pattern established in 2D.5B/C/D: a plain
 * .ts module so the ownership-critical logic is unit-testable without
 * a JSX transform.
 *
 * Ownership is enforced as part of the database query itself — the
 * TeamGeneration lookup is `findFirst({ id, groupId })`, not
 * `findUnique(id)` followed by an after-the-fact groupId check — so
 * there is no code path where a foreign-Group row is ever fetched and
 * then merely hidden from the response. A missing generation and a
 * foreign-Group generation both simply produce zero matching rows,
 * indistinguishable from each other by construction, not by a
 * separate branch of logic that could diverge or leak details.
 */

export type PublicPrintGeneration = {
  id: string;
  date: Date;
  updatedAt: Date;
  teams: Array<{
    teamNumber: number;
    players: Array<{ id: string; firstName: string; lastName: string; position: string }>;
  }>;
};

/**
 * Returns null when the URL's (organizationSlug, groupSlug) pair
 * doesn't resolve to a real, active Group, OR when generationId
 * doesn't resolve to a TeamGeneration owned by that Group — including
 * when it exists but is owned by a different Group. The caller must
 * treat both cases identically (notFound()) — never reveal which one
 * occurred.
 *
 * groupId is used only to constrain the query and is discarded from
 * the returned DTO — the render layer never sees it.
 */
export async function loadPublicGroupPrintData(params: {
  organizationSlug: string;
  groupSlug: string;
  generationId: string;
}): Promise<PublicPrintGeneration | null> {
  const publicGroup = await resolvePublicGroup(
    { organizationSlug: params.organizationSlug, groupSlug: params.groupSlug },
    prisma
  );
  if (!publicGroup) return null;

  const gen = await prisma.teamGeneration.findFirst({
    where: { id: params.generationId, groupId: publicGroup.group.id },
    select: { id: true, date: true, updatedAt: true, teamsJson: true },
  });
  if (!gen) return null;

  // Matches legacy /print/[id]'s exact parsing: a plain JSON.parse
  // with no try/catch. Preserved as-is (not hardened) per Phase
  // 2D.5E §10 — no materially different policy introduced here.
  const teams = JSON.parse(gen.teamsJson) as PublicPrintGeneration["teams"];

  return {
    id: gen.id,
    date: gen.date,
    updatedAt: gen.updatedAt,
    teams,
  };
}
