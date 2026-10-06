import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { loadCanonicalAdminContext } from "../../data";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import { adminMatchesPath } from "@/lib/matchPaths";
import MatchWorkspace from "./MatchWorkspace";

/**
 * M9-A — Match workspace (Match · Attendance · Teams · After the game). Tenant
 * and role come from the URL-resolved context; every action calls the
 * canonical URL-bound APIs. Saving never sends; posting is a separate
 * OWNER/ADMIN action. UI-4 — redesigned presentation only.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export default async function MatchPage({ params }: { params: Params }) {
  const { organizationSlug, groupSlug, matchId } = await params;
  const context = await loadCanonicalAdminContext({ organizationSlug, groupSlug });
  if (!context) notFound();
  const sport = findSport(context.activeGroup.sportKey);
  return (
    <div className="space-y-4">
      <Link
        className="inline-flex min-h-10 items-center gap-1.5 rounded-tbp-sm text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={adminMatchesPath(context.organization.slug, context.activeGroup.slug)}
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All matches · {context.activeGroup.name}
      </Link>
      <MatchWorkspace
        organizationSlug={context.organization.slug}
        groupSlug={context.activeGroup.slug}
        matchId={matchId}
        sport={sportClientView(sport ?? other)}
      />
    </div>
  );
}
