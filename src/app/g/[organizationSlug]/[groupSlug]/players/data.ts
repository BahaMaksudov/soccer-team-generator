import { prisma } from "@/lib/prisma";
import { resolvePublicGroup, type PublicGroupContext } from "@/lib/publicGroup";

/**
 * Phase 2D.5C — resolver gate for the canonical public Players page.
 * Same split-out-of-.tsx pattern as the canonical home page's
 * ./players/../data.ts (Phase 2D.5B report §E): this repo's Vitest
 * config has no JSX transform, so the resolution logic lives in a
 * plain .ts module the untested page.tsx consumes.
 *
 * This page doesn't query Player itself — the client component fetches
 * the roster from the canonical API — so all this loader does is
 * confirm the URL resolves to a real, active Group before rendering
 * anything (and before the browser is ever told a valid
 * organizationSlug/groupSlug pair exists to call the API with).
 */
export async function loadPublicGroupPlayersPageData(params: {
  organizationSlug: string;
  groupSlug: string;
}): Promise<{ publicGroup: PublicGroupContext } | null> {
  const publicGroup = await resolvePublicGroup(
    { organizationSlug: params.organizationSlug, groupSlug: params.groupSlug },
    prisma
  );
  if (!publicGroup) return null;

  return { publicGroup };
}
