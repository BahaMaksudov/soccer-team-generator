/**
 * Installable app (PWA) — one place for the values the manifest, the root metadata and the
 * middleware share. No service worker: Chrome/Edge/Samsung Internet and iOS install without one,
 * and nothing (pages, API data, auth) is ever cached by the app itself.
 */

/** --tbp-pitch (oklch 0.24 0.04 160) — the app header / sidebar; the installed app's status bar. */
export const PWA_THEME_COLOR = "#0b2519";
/** --tbp-background (oklch 0.985 0.004 95) — the launch (splash) screen behind the icon. */
export const PWA_BACKGROUND_COLOR = "#fbfaf7";

/** The home-screen launch URL: the site root, tagged so the middleware can route it (below). */
export const PWA_LAUNCH_SOURCE = "pwa";
export const PWA_START_URL = `/?source=${PWA_LAUNCH_SOURCE}`;

/**
 * Where a launch from the home screen goes: a signed-in user straight into the app (My
 * Organizations); anyone else to the normal homepage (Sign In / Get Started), without the tag.
 * Only the tagged root is affected — the website's "/" is unchanged for browser visitors.
 * null = not a home-screen launch.
 */
export function pwaLaunchRedirect(pathname: string, search: string, authenticated: boolean): string | null {
  if (pathname !== "/") return null;
  if (new URLSearchParams(search).get("source") !== PWA_LAUNCH_SOURCE) return null;
  return authenticated ? "/admin" : "/";
}
