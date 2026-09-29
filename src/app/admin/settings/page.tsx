import { redirect } from "next/navigation";

/**
 * Phase 2D.6D.5E.2 — retired legacy page. Its capabilities live in the
 * canonical tenant-bound Admin workspace
 * (/admin/o/[organizationSlug]/g/[groupSlug]). This only forwards old
 * bookmarks to bare /admin, which alone decides where to go (single
 * Group → canonical redirect; otherwise a selector). No tenant is
 * chosen here.
 */
export default function LegacySettingsPageRedirect() {
  redirect("/admin");
}
