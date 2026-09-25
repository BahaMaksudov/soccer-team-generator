import { prisma } from "@/lib/prisma";

/**
 * Phase 2D.5F — legacy Print redirect resolver.
 *
 * Different trust model from resolvePublicGroup(): that resolver goes
 * slug -> Group; this one goes generationId -> persisted ownership ->
 * canonical slugs, because an old /print/[id] bookmark only ever
 * carried a generation ID, never a Group identity. The generation's
 * OWN persisted groupId is the only signal used to determine where to
 * send the visitor — never a client-supplied value, never the
 * transitional default-public-Group configuration (a specific
 * generation always belongs to a specific, real Group; using the
 * configured default here would be actively wrong the moment a second
 * Organization/Group exists).
 *
 * This function only ever determines a REDIRECT DESTINATION. It never
 * returns team/player content — the legacy route must not render
 * TeamGeneration data directly (see Phase 2D.5E report §B: the old
 * inline rendering was also the source of a runtime crash, which
 * disappears entirely now that this route is redirect-only).
 *
 * Returns null (-> generic 404, never content, never a hint about
 * which half failed) when: the generation doesn't exist; it has no
 * groupId (nullable in the schema, see prisma/schema.prisma); its
 * Group doesn't exist; or its Group is inactive.
 */
export async function resolveLegacyPrintRedirect(
  generationId: string
): Promise<{ organizationSlug: string; groupSlug: string } | null> {
  const gen = await prisma.teamGeneration.findUnique({
    where: { id: generationId },
    select: { groupId: true },
  });
  if (!gen || !gen.groupId) return null;

  const group = await prisma.group.findUnique({
    where: { id: gen.groupId },
    select: {
      slug: true,
      isActive: true,
      organization: { select: { slug: true } },
    },
  });
  if (!group || !group.isActive) return null;

  return { organizationSlug: group.organization.slug, groupSlug: group.slug };
}
