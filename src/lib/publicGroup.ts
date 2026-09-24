/**
 * Phase 2D.5B — public (unauthenticated) tenant resolution.
 *
 * Deliberately separate from tenantContext.ts: there is no session
 * here, and there never should be — public visitors have none. Tenant
 * identity for a public request comes only from the two URL slug
 * segments (organizationSlug, groupSlug), validated against persisted
 * Organization/Group relations. It is a request for "the Group named
 * by this URL", not a claim of ownership — never accept a client-
 * supplied groupId/organizationId as authority anywhere downstream of
 * this resolver.
 *
 * Same testability shape as resolveTenantContextForEmail(): the
 * resolution logic is a pure function over a minimal injectable data
 * source, so it's unit-testable with a hand-written fixture — no
 * PrismaClient, no mocking framework required.
 */

/** Safe, minimal DTO — built field-by-field, never by spreading a raw
 * Prisma row, so a future schema field can never leak through here by
 * accident. */
export type PublicGroupContext = {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  group: {
    id: string;
    name: string;
    slug: string;
    sportKey: string;
    timezone: string;
  };
};

/** The minimal slice of Prisma this resolver needs. Real usage passes
 * the actual `prisma` client (which structurally satisfies this);
 * tests pass a small hand-written fixture. */
export interface PublicGroupDataSource {
  organization: {
    findUnique(args: {
      where: { slug: string };
    }): Promise<{ id: string; name: string; slug: string } | null>;
  };
  group: {
    findUnique(args: {
      where: { organizationId_slug: { organizationId: string; slug: string } };
    }): Promise<{
      id: string;
      name: string;
      slug: string;
      sportKey: string;
      timezone: string;
      isActive: boolean;
    } | null>;
  };
}

/**
 * Resolves the public Group identified by a URL's two slug segments,
 * or returns null. Two deterministic, indexed lookups — a globally
 * unique key (Organization.slug), then a compound-unique key
 * (Group.organizationId_slug) — never a "first match" query.
 *
 * Returns null (never throws, never defaults) when:
 *   - the organization slug doesn't exist;
 *   - the group slug doesn't exist under that organization (including
 *     when it exists only under a DIFFERENT organization — a
 *     Group.slug is only unique per-Organization, so this is a real
 *     case, not a hypothetical one);
 *   - the resolved Group is not active.
 *
 * Callers (public pages) must translate a null result into a generic
 * 404 (Next's notFound()) — never a redirect, never a fallback to any
 * other Group, and never a response that reveals which half of the
 * slug pair was wrong.
 */
export async function resolvePublicGroup(
  params: { organizationSlug: string; groupSlug: string },
  db: PublicGroupDataSource
): Promise<PublicGroupContext | null> {
  const organization = await db.organization.findUnique({
    where: { slug: params.organizationSlug },
  });
  if (!organization) return null;

  const group = await db.group.findUnique({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: params.groupSlug,
      },
    },
  });
  if (!group || !group.isActive) return null;

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
    },
    group: {
      id: group.id,
      name: group.name,
      slug: group.slug,
      sportKey: group.sportKey,
      timezone: group.timezone,
    },
  };
}
