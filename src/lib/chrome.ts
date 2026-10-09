/**
 * UI-1/UI-2/UI-3 — which global chrome the root layout renders.
 *
 * Every route keeps the pre-redesign chrome (soccer background, SiteHeader,
 * centered <main>, footer) EXCEPT the redesigned paths below:
 *   - PUBLIC redesigned pages (marketing homepage, auth screens) — never
 *     auth-gated by middleware;
 *   - AUTHENTICATED redesigned pages (UI-3 app shell: /admin/**, /me/**,
 *     /account/**, UI-7: /onboarding) — still auth-gated by middleware exactly as before; they
 *     render their own shell via nested layouts.
 * The decision is made on the SERVER: middleware tags requests for a
 * redesigned path with a request header and RootLayout reads it, so every
 * other route — including nested notFound() 404s — server-renders exactly
 * the same markup as before.
 *
 * Input is the URL path only (no tenant, session, cookie or storage). A
 * client spoofing the header can only change their own page's presentation.
 * Keep in sync with the static middleware matcher (asserted in tests).
 */
export const CHROME_HEADER = "x-tbp-chrome";
export const REDESIGN_CHROME = "redesign";

/** Public redesigned pages (exact paths / subtrees). */
export const REDESIGNED_PATHS: readonly string[] = ["/", "/login", "/signup", "/verify-email", "/pricing"];
// M9.3 — /share/m/** is the redesigned player Match page (Match Link / share link; never auth-gated).
export const REDESIGNED_PREFIXES: readonly string[] = ["/verify-email/", "/share/m/"];

/** UI-3 — authenticated app-shell pages (exact paths / subtrees). */
export const APP_SHELL_PATHS: readonly string[] = ["/admin", "/me", "/account", "/onboarding"];
export const APP_SHELL_PREFIXES: readonly string[] = ["/admin/", "/me/", "/account/", "/onboarding/"];

export type ChromeMode = "redesign" | "legacy";

const matches = (pathname: string, paths: readonly string[], prefixes: readonly string[]) =>
  paths.includes(pathname) || prefixes.some((p) => pathname.startsWith(p));

/** Public redesigned page (never auth-gated). */
export function isPublicRedesignedPath(pathname: string | null | undefined): boolean {
  return typeof pathname === "string" && matches(pathname, REDESIGNED_PATHS, REDESIGNED_PREFIXES);
}

/** UI-3 app-shell page (auth-gated by middleware). */
export function isAppShellPath(pathname: string | null | undefined): boolean {
  return typeof pathname === "string" && matches(pathname, APP_SHELL_PATHS, APP_SHELL_PREFIXES);
}

export function isRedesignedPath(pathname: string | null | undefined): boolean {
  return isPublicRedesignedPath(pathname) || isAppShellPath(pathname);
}

export function chromeModeFromHeader(value: string | null | undefined): ChromeMode {
  return value === REDESIGN_CHROME ? "redesign" : "legacy";
}
