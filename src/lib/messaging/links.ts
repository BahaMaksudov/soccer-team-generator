import { getAppBaseUrl } from "@/lib/email/config";
import { SHARE_PATH } from "@/lib/shareLinks";
import { canonicalMatchPath, shareMatchPath } from "@/lib/matchPaths";
import type { GroupVisibility } from "@/lib/publicGroup";

/**
 * Which player-facing URL (if any) a message may carry for a Group:
 *   PUBLIC  → the canonical Group page on APP_BASE_URL;
 *   LINK    → only an explicitly supplied share URL on APP_BASE_URL
 *             (/share#…). Raw share tokens are never stored, so a
 *             message can carry one only when the caller has it;
 *   PRIVATE → never a URL.
 * Misconfiguration never breaks a message: it just omits the link.
 *
 * M9-C — with `matchId` (teams published for a Match) the link targets THAT
 * Match's page: PUBLIC → /g/<org>/<group>/m/<matchId>; LINK → the supplied
 * share link's token re-used as /share/m/<matchId>#<token>; PRIVATE → none.
 * The Match is always the explicit one passed in, never inferred.
 */
export function playerFacingViewUrl(params: {
  visibility: GroupVisibility;
  organizationSlug: string;
  groupSlug: string;
  shareUrl?: string | null;
  matchId?: string | null;
  env?: Record<string, string | undefined>;
}): string | null {
  let base: string;
  try {
    base = getAppBaseUrl(params.env);
  } catch {
    return null;
  }
  if (params.visibility === "PUBLIC") {
    if (params.matchId) return `${base}${canonicalMatchPath(params.organizationSlug, params.groupSlug, params.matchId)}`;
    return `${base}/g/${encodeURIComponent(params.organizationSlug)}/${encodeURIComponent(params.groupSlug)}`;
  }
  if (params.visibility === "LINK") {
    const url = params.shareUrl ?? "";
    const valid = url.startsWith(`${base}${SHARE_PATH}#`) && url.length > `${base}${SHARE_PATH}#`.length;
    if (!valid) return null;
    return params.matchId ? `${base}${shareMatchPath(params.matchId, url.slice(`${base}${SHARE_PATH}#`.length))}` : url;
  }
  return null;
}
