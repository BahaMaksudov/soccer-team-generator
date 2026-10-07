/** @type {import('next').NextConfig} */

// M9.3 — player-facing / private surfaces are never indexed (defense in depth
// next to robots.txt and page metadata). Marketing pages are unaffected.
const NOINDEX = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
const NOINDEX_PATHS = ["/share", "/share/:path*", "/g/:path*", "/players", "/players/:path*", "/print/:path*", "/claim", "/claim/:path*", "/invite/:path*", "/me", "/me/:path*"];

module.exports = {
  async headers() {
    return NOINDEX_PATHS.map((source) => ({ source, headers: NOINDEX }));
  },
};
