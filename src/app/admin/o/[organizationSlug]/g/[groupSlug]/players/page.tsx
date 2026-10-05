import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "../data";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import { isManager } from "@/lib/tenantRoute";
import PlayersRoster from "./PlayersRoster";

/**
 * UI-5 — organizer Players page. Tenant and role come from the URL-resolved
 * context (foreign / unknown Organization or Group → generic 404); the roster
 * talks to the existing tenant-bound /players APIs. Positions come from the
 * Group's sport registry.
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function PlayersPage({ params }: { params: Params }) {
  const context = await loadCanonicalAdminContext(await params);
  if (!context) notFound();
  const sport = findSport(context.activeGroup.sportKey);
  return (
    <PlayersRoster
      organizationSlug={context.organization.slug}
      groupSlug={context.activeGroup.slug}
      groupName={context.activeGroup.name}
      sport={sportClientView(sport ?? other)}
      canManage={isManager(context)}
    />
  );
}
