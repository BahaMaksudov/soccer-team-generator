/**
 * Phase 2D.5E — pure canonical Print link construction, extracted so
 * it's directly unit-testable without a JSX transform (same rationale
 * as canonicalGroupPath.ts). Organization and Group identity come
 * only from the already-resolved slugs already in scope on the
 * canonical home page — never from anything on the TeamGeneration
 * row itself, so a print link can never point at the wrong tenant.
 */
export function buildCanonicalPrintHref(
  organizationSlug: string,
  groupSlug: string,
  generationId: string
): string {
  return `/g/${organizationSlug}/${groupSlug}/print/${generationId}`;
}
