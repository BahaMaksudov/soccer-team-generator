/**
 * M9-C — player-facing Match URL paths (dependency-free; safe anywhere).
 *  - canonical: /g/<org>/<group>/m/<matchId> (PUBLIC, or signed-in authorized viewers)
 *  - share:     /share/m/<matchId>#<token>  (LINK; token in the FRAGMENT, never sent to servers or in Referer)
 */
export const canonicalMatchPath = (organizationSlug: string, groupSlug: string, matchId: string) =>
  `/g/${encodeURIComponent(organizationSlug)}/${encodeURIComponent(groupSlug)}/m/${encodeURIComponent(matchId)}`;
export const SHARE_MATCH_PATH = "/share/m";
export const shareMatchPath = (matchId: string, token: string) => `${SHARE_MATCH_PATH}/${encodeURIComponent(matchId)}#${token}`;
