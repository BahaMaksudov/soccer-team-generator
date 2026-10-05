/**
 * M9-C — player-facing Match URL paths (dependency-free; safe anywhere).
 *  - canonical: /g/<org>/<group>/m/<matchId> (PUBLIC, or signed-in authorized viewers)
 *  - share:     /share/m/<matchId>#<token>  (LINK; token in the FRAGMENT, never sent to servers or in Referer)
 */
export const canonicalMatchPath = (organizationSlug: string, groupSlug: string, matchId: string) =>
  `/g/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(groupSlug)}/m/${encodeURIComponent(matchId)}`;
export const SHARE_MATCH_PATH = "/share/m";
export const shareMatchPath = (matchId: string, token: string) => `${SHARE_MATCH_PATH}/${encodeURIComponent(matchId)}#${token}`;

/** UI-4 — organizer (admin) Group, Matches list and Match workspace paths. */
export const adminGroupPath = (organizationSlug: string, groupSlug: string) => `/admin/o/${encodeURIComponent(organizationSlug)}/g/${encodeURIComponent(groupSlug)}`;
export const adminMatchesPath = (organizationSlug: string, groupSlug: string) => `${adminGroupPath(organizationSlug, groupSlug)}/matches`;
/** UI-8 — the ONE organizer location for group-level settings (OWNER/ADMIN). */
export const adminGroupSettingsPath = (organizationSlug: string, groupSlug: string) => `${adminGroupPath(organizationSlug, groupSlug)}/settings`;
export const canonicalAdminMatchPath = (organizationSlug: string, groupSlug: string, matchId: string) =>
  `${adminMatchesPath(organizationSlug, groupSlug)}/${encodeURIComponent(matchId)}`;
