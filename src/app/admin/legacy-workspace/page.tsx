import { redirect } from "next/navigation";

/**
 * Phase 2D.6D.5E.4 — retired legacy Admin workspace. Every capability
 * it offered now lives in the canonical tenant-bound Admin workspace
 * (/admin/o/[organizationSlug]/g/[groupSlug]). This only forwards old
 * bookmarks to bare /admin, which alone decides where to go (single
 * Group → canonical redirect; otherwise a selector). No tenant is
 * chosen here, and the legacy AdminWorkspace is no longer rendered.
 */
export default function LegacyAdminWorkspacePageRedirect() {
  redirect("/admin");
}
