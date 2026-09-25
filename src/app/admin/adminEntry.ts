import type { AccessibleOrganization } from "@/lib/tenantContext";

/**
 * Phase 2D.6C — pure decision logic for bare `/admin`, kept out of
 * page.tsx so it's directly unit-testable without a JSX transform
 * (same rationale as every other `.ts`-not-`.tsx` split established
 * since Phase 2D.5B).
 *
 * Deliberately conservative: the ONLY case that auto-redirects is
 * "exactly one accessible Organization AND that Organization has
 * exactly one active Group" — the objectively unambiguous case. Every
 * other shape (multiple Organizations, regardless of how many of them
 * have active Groups; one Organization with multiple active Groups)
 * renders a selection screen instead of guessing. Never uses `[0]`
 * without a preceding `length === 1` check; never queries anything —
 * this function is synchronous and takes the already-resolved
 * accessible-tenant list as input.
 */
export type AdminEntryResult =
  | { kind: "redirect"; href: string }
  | { kind: "select"; organizations: AccessibleOrganization[] }
  | { kind: "no-access" }
  | { kind: "no-active-groups"; organization: AccessibleOrganization };

export function resolveAdminEntry(organizations: AccessibleOrganization[]): AdminEntryResult {
  if (organizations.length === 0) {
    return { kind: "no-access" };
  }

  if (organizations.length > 1) {
    // Multiple Organizations are always ambiguous for auto-selection,
    // even if only one of them currently has active Groups — never
    // silently pick "the one that happens to qualify."
    return { kind: "select", organizations };
  }

  const organization = organizations[0];

  if (organization.groups.length === 0) {
    return { kind: "no-active-groups", organization };
  }

  if (organization.groups.length > 1) {
    return { kind: "select", organizations };
  }

  const group = organization.groups[0];
  return {
    kind: "redirect",
    href: `/admin/o/${encodeURIComponent(organization.slug)}/g/${encodeURIComponent(group.slug)}`,
  };
}
