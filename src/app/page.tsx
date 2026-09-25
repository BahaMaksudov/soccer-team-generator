import { redirect } from "next/navigation";
import { getDefaultPublicGroupSlugs } from "@/lib/defaultPublicGroup";

/**
 * Phase 2D.5F — legacy root compatibility redirect.
 *
 * This page no longer queries TeamGeneration (it previously ran a
 * fully unscoped `findMany()` across every Group — see Phase 2D.5A
 * §C/§R for the original finding). It exists only to preserve old
 * bookmarks to `/` while exactly one Organization/Group exists in
 * production: it redirects to the explicitly configured default
 * public Group's canonical home (src/lib/defaultPublicGroup.ts) —
 * never a database "first Group" lookup.
 *
 * If that configuration is missing or invalid, this fails closed: it
 * renders a neutral message and queries nothing, rather than
 * guessing a tenant. See Phase 2D.5F report §F for the exact policy.
 */
export default function LegacyRootRedirect() {
  const defaults = getDefaultPublicGroupSlugs();

  if (!defaults) {
    return (
      <div className="p-6 text-center text-gray-600">
        This application is not yet configured. Please contact an administrator.
      </div>
    );
  }

  redirect(`/g/${defaults.organizationSlug}/${defaults.groupSlug}`);
}
