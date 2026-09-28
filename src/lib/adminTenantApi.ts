/**
 * Phase 2D.6D.1 — deterministic canonical Admin API path construction.
 * Generic enough for later Generate/Publish/Settings/Telegram
 * migrations to reuse, without over-engineering it now: it only ever
 * builds a path from the two already-validated slugs a canonical
 * Server Component already resolved, plus a sub-path. It never
 * accepts or embeds a database id — organizationId/groupId/
 * membershipId are not inputs here and never appear in the result.
 */
export function adminTenantApiPath(params: {
  organizationSlug: string;
  groupSlug: string;
  path: string;
}): string {
  const org = encodeURIComponent(params.organizationSlug);
  const group = encodeURIComponent(params.groupSlug);
  const suffix = params.path.startsWith("/") ? params.path : `/${params.path}`;
  return `/api/admin/o/${org}/g/${group}${suffix}`;
}
