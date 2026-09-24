import { notFound } from "next/navigation";
import { loadPublicGroupPlayersPageData } from "./data";
import CanonicalPlayersClient from "./players-client";

/**
 * Phase 2D.5C — canonical public Players page.
 *
 * Resolves the URL Group via resolvePublicGroup() (through ./data.ts)
 * before rendering anything. An unresolvable organizationSlug/
 * groupSlug pair — unknown organization, unknown group, a group
 * belonging to a different organization, or an inactive group — is a
 * plain 404, never a redirect to legacy /players, never a default
 * Group, never inferred from a session (there isn't one).
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function PublicGroupPlayers({ params }: { params: Params }) {
  const { organizationSlug, groupSlug } = await params;

  const data = await loadPublicGroupPlayersPageData({ organizationSlug, groupSlug });
  if (!data) notFound();

  return <CanonicalPlayersClient organizationSlug={organizationSlug} groupSlug={groupSlug} />;
}
