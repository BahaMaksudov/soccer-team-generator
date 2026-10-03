import ShareMatchView from "./ShareMatchView";

/**
 * M9-C — Match page via a Group share link (/share/m/<matchId>#<token>).
 * The token stays in the URL fragment; ShareMatchView posts it to
 * /api/share/match. No account needed. Never indexed; no Referer.
 */
export const metadata = {
  title: "Team Balance Pro — Match",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Params = Promise<{ matchId: string }>;

export default async function ShareMatchPage({ params }: { params: Params }) {
  const { matchId } = await params;
  return <ShareMatchView matchId={matchId} />;
}
