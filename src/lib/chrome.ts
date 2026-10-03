/**
 * UI-1/UI-2 — which global chrome the root layout renders.
 *
 * Every route keeps the pre-redesign chrome (soccer background, SiteHeader,
 * centered <main>, footer) EXCEPT the redesigned paths below (the marketing
 * homepage and the authentication screens). The decision is made on the
 * SERVER: middleware tags requests for a redesigned path with a request
 * header and RootLayout reads it, so every other route — including nested
 * notFound() 404s — server-renders exactly the same markup as before.
 *
 * Input is the URL path only (no tenant, session, cookie or storage). A
 * client spoofing the header can only change their own page's presentation.
 * Keep in sync with the static middleware matcher (asserted in tests).
 */
export const CHROME_HEADER = "x-tbp-chrome";
export const REDESIGN_CHROME = "redesign";
export const REDESIGNED_PATHS: readonly string[] = ["/", "/login", "/signup", "/verify-email"];
/** Redesigned subtrees (every path below them). */
export const REDESIGNED_PREFIXES: readonly string[] = ["/verify-email/"];

export type ChromeMode = "redesign" | "legacy";

export function isRedesignedPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== "string") return false;
  return REDESIGNED_PATHS.includes(pathname) || REDESIGNED_PREFIXES.some((p) => pathname.startsWith(p));
}

export function chromeModeFromHeader(value: string | null | undefined): ChromeMode {
  return value === REDESIGN_CHROME ? "redesign" : "legacy";
}
