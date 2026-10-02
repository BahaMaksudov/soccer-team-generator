import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "../../data";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import MatchWorkspace from "./MatchWorkspace";

/**
 * M9-A — Match workspace (Match · Attendance · Teams · Communication). Tenant
 * and role come from the URL-resolved context; every action calls the
 * canonical URL-bound APIs. Saving never sends; posting is a separate
 * OWNER/ADMIN action.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string; matchId: string }>;

export default async function MatchPage({ params }: { params: Params }) {
  const { organizationSlug, groupSlug, matchId } = await params;
  const context = await loadCanonicalAdminContext({ organizationSlug, groupSlug });
  if (!context) notFound();
  const sport = findSport(context.activeGroup.sportKey);
  const base = `/admin/o/${encodeURIComponent(context.organization.slug)}/g/${encodeURIComponent(context.activeGroup.slug)}`;
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Match — {context.activeGroup.name}</h1>
        <Link className="text-sm underline" href={base}>
          Back to group
        </Link>
      </div>
      <MatchWorkspace
        organizationSlug={context.organization.slug}
        groupSlug={context.activeGroup.slug}
        matchId={matchId}
        sport={sportClientView(sport ?? other)}
      />
    </div>
  );
}
