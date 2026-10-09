import type { MetadataRoute } from "next";

/**
 * M9.3 — crawler policy. The marketing/landing pages stay indexable; every
 * player-facing or private surface is disallowed (group/match/share pages
 * carry player names; there is no public SEO for rosters). Those pages also
 * send noindex themselves (metadata + X-Robots-Tag, next.config.js).
 */
export const PRIVATE_PREFIXES = ["/share", "/g/", "/api/", "/admin", "/me", "/claim", "/account", "/onboarding", "/invite", "/print", "/players", "/verify-email"] as const;

export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_PREFIXES] }] };
}
