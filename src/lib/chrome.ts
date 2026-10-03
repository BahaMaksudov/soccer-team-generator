/**
 * UI-1 — which global chrome the root layout renders.
 *
 * Every route keeps the pre-redesign chrome (soccer background, SiteHeader,
 * centered <main>, footer) EXCEPT the redesigned paths below. The decision is
 * made on the SERVER: middleware tags requests for a redesigned path with a
 * request header and RootLayout reads it, so every other route — including
 * nested notFound() 404s — server-renders exactly the same markup as before.
 *
 * Input is the URL path only (no tenant, session, cookie or storage). A
 * client spoofing the header can only change their own page's presentation.
 */
export const CHROME_HEADER = "x-tbp-chrome";
export const MARKETING_CHROME = "marketing";
export const REDESIGNED_PATHS: readonly string[] = ["/"];

export type ChromeMode = "marketing" | "legacy";

export function isRedesignedPath(pathname: string | null | undefined): boolean {
  return typeof pathname === "string" && REDESIGNED_PATHS.includes(pathname);
}

export function chromeModeFromHeader(value: string | null | undefined): ChromeMode {
  return value === MARKETING_CHROME ? "marketing" : "legacy";
}
