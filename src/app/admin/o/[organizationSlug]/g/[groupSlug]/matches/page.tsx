import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "../data";
import { loadGroupOverview } from "@/lib/groupOverview";
import { MatchList } from "@/components/game-day/MatchList";
import { isManager } from "@/lib/tenantRoute";
import CreateMatchForm from "./CreateMatchForm";
import { prisma } from "@/lib/prisma";

/**
 * UI-4 — canonical Matches page of one Group (replaces the in-page Matches
 * section). Tenant and role come from the URL-resolved context; a foreign or
 * unknown Organization/Group is the generic 404. Upcoming / past use exactly
 * listMatches()'s rule (SCHEDULED and dated today or later = upcoming).
 * UI-4A — creating a match is an organizer mutation: the form is shown to
 * OWNER/ADMIN only, and POST /matches rejects MEMBER server-side (generic 404).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function MatchesPage({ params }: { params: Params }) {
  const context = await loadCanonicalAdminContext(await params);
  if (!context) notFound();
  const overview = await loadGroupOverview(context);
  const canceled = overview.past.filter((m) => m.status === "CANCELED");
  const past = overview.past.filter((m) => m.status !== "CANCELED");
  // M9.2 — the Group's active Communities (a new Match names its roster).
  const communities = isManager(context)
    ? await prisma.community.findMany({ where: { groupId: context.activeGroup.id, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })
    : [];
  const venues = isManager(context)
    ? await prisma.venue.findMany({ where: { organizationId: context.organization.id, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, address: true } })
    : [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow truncate">{context.activeGroup.name}</p>
          <h1 className="mt-1 text-3xl font-extrabold">Matches</h1>
        </div>
      </header>
      {isManager(context) && <CreateMatchForm organizationSlug={context.organization.slug} groupSlug={context.activeGroup.slug} communities={communities} venues={venues} />}

      <section aria-labelledby="upcoming-h" className="space-y-3">
        <h2 id="upcoming-h" className="text-xl font-extrabold">Upcoming <span className="text-base font-semibold text-muted-foreground">({overview.upcoming.length})</span></h2>
        <MatchList matches={overview.upcoming} emptyText="No upcoming matches." />
      </section>
      <section aria-labelledby="past-h" className="space-y-3">
        <h2 id="past-h" className="text-xl font-extrabold">Past &amp; completed <span className="text-base font-semibold text-muted-foreground">({past.length})</span></h2>
        <MatchList matches={past} emptyText="None yet." />
      </section>
      {canceled.length > 0 && (
        <section aria-labelledby="canceled-h" className="space-y-3">
          <h2 id="canceled-h" className="text-xl font-extrabold">Canceled <span className="text-base font-semibold text-muted-foreground">({canceled.length})</span></h2>
          <MatchList matches={canceled} emptyText="" />
        </section>
      )}
    </div>
  );
}
