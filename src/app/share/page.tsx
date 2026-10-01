import ShareView from "./ShareView";

/**
 * M6-A — player-facing view for a Group share link (/share#<token>).
 * The token stays in the URL fragment (never sent to the server or in
 * Referer); ShareView posts it to /api/share/view. No account needed.
 */
export const metadata = {
  title: "Team Balance Pro — Teams",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default function SharePage() {
  return <ShareView />;
}
