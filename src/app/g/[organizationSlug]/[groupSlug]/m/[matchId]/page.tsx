import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { loadMatchForViewer } from "@/lib/matchPage";
import Link from "next/link";
import { MatchPageShell, MatchView } from "@/components/match-link/MatchView";

/**
 * M9-C — canonical player-facing Match page. PUBLIC Groups: anyone;
 * LINK/PRIVATE Groups: signed-in organization members or claimed Players
 * of the Group (the /g layout + loadMatchForViewer gate). Anonymous LINK
 * viewers use /share/m/[matchId]#<token>. Unknown/foreign/unauthorized
 * → the same 404. Never indexed.
 *
 * Telegram publishing — "View teams online" lands here: rendered with the
 * redesigned player view shared with the Match Link page (same URL, so every
 * older Telegram message and shared link keeps working, now in the new look).
 * The view is the allow-listed DTO (names and roles; never ids, ratings or
 * admin controls).
 */
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Team Balance Pro — Match",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export default async function PlayerMatchPage({ params }: { params: Params }) {
  const { organizationSlug, groupSlug, matchId } = await params;
  const view = await loadMatchForViewer({ organizationSlug, groupSlug, matchId });
  if (!view) notFound();
  const session = await getServerSession(authOptions);
  return (
    <MatchPageShell
      footer={
        session?.user ? null : (
          <p>
            Organizer?{" "}
            <Link className="font-semibold text-primary underline" href="/login">
              Sign in
            </Link>
          </p>
        )
      }
    >
      <MatchView view={view} title={view.group.teamName || view.group.name} subtitle={view.group.organizationName} />
    </MatchPageShell>
  );
}
