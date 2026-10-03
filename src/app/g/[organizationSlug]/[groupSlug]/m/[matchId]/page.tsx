import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";
import { loadMatchForViewer } from "@/lib/matchPage";
import PlayerMatchCard from "@/app/components/PlayerMatchCard";

/**
 * M9-C — canonical player-facing Match page. PUBLIC Groups: anyone;
 * LINK/PRIVATE Groups: signed-in organization members or claimed Players
 * of the Group (the /g layout + loadMatchForViewer gate). Anonymous LINK
 * viewers use /share/m/[matchId]#<token>. Unknown/foreign/unauthorized
 * → the same 404. Never indexed.
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
  return <PlayerMatchCard view={view} signInHref={session?.user ? null : "/login"} />;
}
