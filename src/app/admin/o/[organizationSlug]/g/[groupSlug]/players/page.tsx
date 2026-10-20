import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "../data";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import { isManager } from "@/lib/tenantRoute";
import PlayersRoster from "./PlayersRoster";
import InvitePlayersCard from "./InvitePlayersCard";

/**
 * UI-5 — organizer Players page. Tenant and role come from the URL-resolved
 * context (foreign / unknown Organization or Group → generic 404); the roster
 * talks to the existing tenant-bound /players APIs. Positions come from the
 * Group's sport registry. M13A — "Invite players" (join link + join requests)
 * for OWNER/ADMIN below the roster.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function PlayersPage({ params }: { params: Params }) {
  const context = await loadCanonicalAdminContext(await params);
  if (!context) notFound();
  const sport = sportClientView(findSport(context.activeGroup.sportKey) ?? other);
  const canManage = isManager(context);
  return (
    <div className="space-y-6">
      <PlayersRoster organizationSlug={context.organization.slug} groupSlug={context.activeGroup.slug} groupName={context.activeGroup.name} sport={sport} canManage={canManage} />
      {/* M13A — invite link + join requests (OWNER/ADMIN; the APIs enforce it too). */}
      {canManage && <InvitePlayersCard organizationSlug={context.organization.slug} groupSlug={context.activeGroup.slug} sport={sport} />}
    </div>
  );
}
