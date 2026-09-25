/**
 * Phase 2D.5D — pure helper for SiteHeader's canonical-route awareness.
 *
 * SiteHeader is the ONLY header instance in the app (rendered once,
 * unconditionally, by RootLayout). Rather than have an ancestor
 * server layout decide what to pass it — which would require
 * RootLayout to know the current route, and it structurally cannot
 * (it sits above the /g/[organizationSlug]/[groupSlug] dynamic
 * segments and receives no params for them) — SiteHeader determines
 * its own canonical-vs-legacy behavior from its own client-side
 * pathname. This keeps the single-header invariant true by
 * construction: no second header is ever mounted.
 *
 * Extracted as a pure function (not inlined in the "use client"
 * component) so it's directly unit-testable without a JSX transform,
 * matching the precedent set in Phase 2D.5B/2D.5C.
 */
export type CanonicalGroupPath = {
  organizationSlug: string;
  groupSlug: string;
};

/**
 * Matches /g/{organizationSlug}/{groupSlug} and any nested path below
 * it (e.g. .../players). Returns null for every other pathname,
 * including plain /g or /g/only-one-segment. Never guesses — an
 * incomplete match is treated as "not a canonical route".
 */
export function parseCanonicalGroupPath(pathname: string | null | undefined): CanonicalGroupPath | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/g\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  return { organizationSlug: match[1], groupSlug: match[2] };
}
