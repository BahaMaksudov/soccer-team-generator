import AdminWorkspace from "../components/AdminWorkspace";

/**
 * TEMPORARY COMPATIBILITY ROUTE — remove once Generate/Publish/
 * Settings/Telegram finish their canonical (Phase 2D.6D+) migration.
 *
 * Renders the preserved AdminWorkspace component unchanged (Phase
 * 2D.6C relocated it here verbatim; nothing about it was modified for
 * this route). AdminWorkspace still calls the legacy flat
 * `/api/admin/*` endpoints, which still resolve tenancy via the old
 * zero-argument `requireTenantContext()` — safe only because
 * production currently has exactly one Organization and one active
 * Group, so that resolver can never be ambiguous. Do not add a
 * tenant-selection fallback or a default-Group mechanism here; if a
 * second Organization/Group is ever introduced before the canonical
 * migration finishes, this route must be removed first, not patched.
 */
export default function LegacyAdminWorkspacePage() {
  return <AdminWorkspace />;
}
