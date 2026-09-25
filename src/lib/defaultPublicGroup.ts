/**
 * Phase 2D.5F — explicit, transitional default-public-Group
 * configuration for legacy browser-page compatibility redirects
 * (`/` -> canonical home, `/players` -> canonical Players).
 *
 * This is a compatibility bridge, NOT tenant discovery. It exists
 * only because exactly one Organization/Group exists in production
 * today and old bookmarks to `/` and `/players` deserve to keep
 * working. It must never become a general-purpose "pick a Group"
 * mechanism:
 *
 *   - no database query of any kind — reads only two env vars;
 *   - no "first Group" / "only active Group" discovery;
 *   - no fallback to AppSetting, session, or tenantContext;
 *   - missing or empty-after-trim values fail closed (return null),
 *     never silently select a tenant.
 *
 * The moment a second Organization/Group exists, this configuration
 * remains exactly as deterministic as it is today — it still only
 * ever points at whatever two slugs are explicitly configured, never
 * "whichever Group happens to exist" or "whichever was created
 * first". See Phase 2D.5F report §D/§E for the full reasoning and
 * the alternative options considered.
 */
export type DefaultPublicGroupSlugs = {
  organizationSlug: string;
  groupSlug: string;
};

export function getDefaultPublicGroupSlugs(): DefaultPublicGroupSlugs | null {
  const organizationSlug = process.env.DEFAULT_PUBLIC_ORGANIZATION_SLUG?.trim();
  const groupSlug = process.env.DEFAULT_PUBLIC_GROUP_SLUG?.trim();

  if (!organizationSlug || !groupSlug) return null;

  return { organizationSlug, groupSlug };
}
