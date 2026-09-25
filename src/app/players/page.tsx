import { redirect } from "next/navigation";
import { getDefaultPublicGroupSlugs } from "@/lib/defaultPublicGroup";

/**
 * Phase 2D.5F — legacy /players compatibility redirect.
 *
 * This page no longer renders PlayersClientPage or fetches
 * /api/public/players (previously fully unscoped — every Group's
 * roster returned to any visitor, see Phase 2D.5A §B/§C). It exists
 * only to preserve old bookmarks to `/players`: it redirects to the
 * explicitly configured default public Group's canonical Players page
 * (src/lib/defaultPublicGroup.ts) — never a database "first Group"
 * lookup.
 *
 * Missing/invalid configuration fails closed: a neutral message,
 * zero queries, no tenant guessed. See Phase 2D.5F report §G.
 */
export default function LegacyPlayersRedirect() {
  const defaults = getDefaultPublicGroupSlugs();

  if (!defaults) {
    return (
      <div className="p-6 text-center text-gray-600">
        This application is not yet configured. Please contact an administrator.
      </div>
    );
  }

  redirect(`/g/${defaults.organizationSlug}/${defaults.groupSlug}/players`);
}
