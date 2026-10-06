import { notFound } from "next/navigation";
import { loadCanonicalAdminContext } from "../data";
import { findSport, sportClientView } from "@/lib/sports";
import { other } from "@/lib/sports/other";
import { isManager } from "@/lib/tenantRoute";
import GroupSettings from "./GroupSettings";

/**
 * UI-8 — the ONE organizer location for group-level settings: team name,
 * balance weights, visibility / share link, Telegram connection and
 * Telegram voter → player links. Configuration only — match-day Telegram
 * operations (attendance poll, sync, post teams) live in the Match
 * Workspace. Reuses the existing tenant-bound sections unchanged.
 *
 * Tenant and role come from the URL-resolved context; OWNER/ADMIN only —
 * MEMBER, foreign or unknown Organization/Group → the generic 404 (the
 * settings APIs answer 404 for them too).
 */
type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export const metadata = { title: "Group settings — Team Balance Pro" };

export default async function GroupSettingsPage({ params }: { params: Params }) {
  const context = await loadCanonicalAdminContext(await params);
  if (!context || !isManager(context)) notFound();
  const sport = findSport(context.activeGroup.sportKey);
  return (
    <GroupSettings
      organizationSlug={context.organization.slug}
      groupSlug={context.activeGroup.slug}
      groupName={context.activeGroup.name}
      sport={sportClientView(sport ?? other)}
    />
  );
}
