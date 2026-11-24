/** @type {import('next').NextConfig} */

// M9.3 — player-facing / private surfaces are never indexed (defense in depth
// next to robots.txt and page metadata). Marketing pages are unaffected.
const NOINDEX = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
const NOINDEX_PATHS = ["/share", "/share/:path*", "/g/:path*", "/players", "/players/:path*", "/print/:path*", "/claim", "/claim/:path*", "/invite/:path*", "/me", "/me/:path*", "/attend", "/join", "/unsubscribe"];

module.exports = {
  // Installable app — render ALL page metadata in <head> for every client. Next.js 15 otherwise
  // streams it into <body> for regular browsers (dynamic pages), where browsers ignore
  // <link rel="manifest"> (Chrome: "no-manifest", so the app can't be installed) and may ignore
  // the icons. Every page's metadata here is static or synchronous, so nothing waits on it.
  htmlLimitedBots: /.*/,
  async headers() {
    return NOINDEX_PATHS.map((source) => ({ source, headers: NOINDEX }));
  },
};
