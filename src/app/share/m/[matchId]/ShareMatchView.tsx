"use client";

import MatchLinkPage from "@/components/match-link/MatchLinkPage";

/**
 * M9-C / M9.3 — the Match page via a link (/share/m/<matchId>#<token>): the
 * per-Match Match Link (attendance + published state) or the Group share link
 * (published state only). The token stays in the URL fragment.
 */
export default function ShareMatchView({ matchId }: { matchId: string }) {
  return <MatchLinkPage matchId={matchId} />;
}
