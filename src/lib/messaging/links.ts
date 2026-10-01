import { getAppBaseUrl } from "@/lib/email/config";
import { SHARE_PATH } from "@/lib/shareLinks";
import type { GroupVisibility } from "@/lib/publicGroup";

/**
 * Which player-facing URL (if any) a message may carry for a Group:
 *   PUBLIC  → the canonical Group page on APP_BASE_URL;
 *   LINK    → only an explicitly supplied share URL on APP_BASE_URL
 *             (/share#…). Raw share tokens are never stored, so a
 *             message can carry one only when the caller has it;
 *   PRIVATE → never a URL.
 * Misconfiguration never breaks a message: it just omits the link.
 */
export function playerFacingViewUrl(params: {
  visibility: GroupVisibility;
  organizationSlug: string;
  groupSlug: string;
  shareUrl?: string | null;
  env?: Record<string, string | undefined>;
}): string | null {
  let base: string;
  try {
    base = getAppBaseUrl(params.env);
  } catch {
    return null;
  }
  if (params.visibility === "PUBLIC") {
    return `${base}/g/${encodeURIComponent(params.organizationSlug)}/${encodeURIComponent(params.groupSlug)}`;
  }
  if (params.visibility === "LINK") {
    const url = params.shareUrl ?? "";
    return url.startsWith(`${base}${SHARE_PATH}#`) && url.length > `${base}${SHARE_PATH}#`.length ? url : null;
  }
  return null;
}
