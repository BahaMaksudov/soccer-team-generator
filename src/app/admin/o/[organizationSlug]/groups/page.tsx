import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CalendarDays, Globe, Link2, Lock, MessageCircle, Plus, Settings2, Users } from "lucide-react";
import { hasOrgRole, requireOrganizationContextForSlug, TenantContextError, type OrganizationContext } from "@/lib/tenantContext";
import { GROUP_CREATOR_ROLES } from "@/lib/workspaces";
import { loadOrganizationGroups, type OrganizationGroupCard } from "@/lib/organizationGroups";
import { formatLongDateOnly } from "@/lib/dateOnly";
import { formatStartTime } from "@/lib/messaging/content";
import { ROLE_LABELS } from "@/lib/appShell";
import { cn } from "@/lib/cn";

/**
 * UI-5 — the Organization's Groups (visual reference: the approved Lovable
 * Groups screen). Organization from the URL slug, verified against the
 * session User's membership (generic 404 otherwise). Real data only
 * (src/lib/organizationGroups.ts). Create Group = the existing OWNER/ADMIN
 * flow (/groups/new); Settings = the Group's settings page (UI-8: /settings)
 * (OWNER/ADMIN). A Group's sport is fixed at creation.
 */
type Params = Promise<{ organizationSlug: string }>;

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const VIS_ICON = { PRIVATE: Lock, LINK: Link2, PUBLIC: Globe } as const;

export default async function GroupsPage({ params }: { params: Params }) {
  const { organizationSlug } = await params;
  let context: OrganizationContext;
  try {
    context = await requireOrganizationContextForSlug({ organizationSlug });
  } catch (e) {
    if (e instanceof TenantContextError) {
      if (e.code === "EMAIL_NOT_VERIFIED") redirect("/verify-email");
      notFound();
    }
    throw e;
  }
  const { canManage, groups } = await loadOrganizationGroups(context);
  const canCreate = hasOrgRole(context, [...GROUP_CREATOR_ROLES]);
  const newHref = `/admin/o/${encodeURIComponent(context.organization.slug)}/groups/new`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow truncate">{context.organization.name}</p>
          <h1 className="mt-1 text-3xl font-extrabold">Groups</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {groups.length} {groups.length === 1 ? "group" : "groups"} · Your role: {ROLE_LABELS[context.membership.role]}
          </p>
        </div>
        {canCreate && (
          <Link href={newHref} className={cn("inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90", focusRing)}>
            <Plus className="size-4" aria-hidden="true" /> Create Group
          </Link>
        )}
      </header>

      {groups.length === 0 ? (
        <section className="rounded-tbp-2xl border border-dashed border-border bg-card p-8 text-center">
          <h2 className="text-xl font-extrabold">No groups yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {canCreate ? "A group is one recurring game with its own players and sport, e.g. “Tuesday Basketball”." : "The organization's owners and admins create groups."}
          </p>
          {canCreate && (
            <Link href={newHref} className={cn("mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground", focusRing)}>
              <Plus className="size-4" aria-hidden="true" /> Create Group
            </Link>
          )}
        </section>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label={`Groups in ${context.organization.name}`}>
          {groups.map((g) => (
            <GroupCard key={g.slug} g={g} canManage={canManage} />
          ))}
        </ul>
      )}
    </div>
  );
}

function GroupCard({ g, canManage }: { g: OrganizationGroupCard; canManage: boolean }) {
  const Vis = VIS_ICON[g.visibility];
  const time = g.nextMatch ? formatStartTime(g.nextMatch.startTime) : null;
  return (
    <li className="flex min-w-0 flex-col rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-tbp bg-primary/10 font-display text-sm font-black text-primary" aria-hidden="true">
          {g.sportLabel.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="min-w-0 text-lg font-extrabold">
            <Link href={g.href} className={cn("block truncate hover:underline", focusRing)}>
              {g.name}
            </Link>
          </h2>
          <p className="text-sm text-muted-foreground">{g.sportLabel}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Players</dt>
          <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dd>
            {g.activePlayers} active {g.activePlayers === 1 ? "player" : "players"}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="sr-only">Visibility</dt>
          <Vis className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dd>{g.visibilityLabel}</dd>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:col-span-2">
          <dt className="sr-only">Next match</dt>
          <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <dd className="min-w-0 truncate">
            {g.nextMatch ? (
              <>
                Next: {formatLongDateOnly(g.nextMatch.date)}
                {time ? ` · ${time}` : ""}
                {g.upcomingMatches > 1 ? ` (+${g.upcomingMatches - 1} more)` : ""}
              </>
            ) : (
              "No upcoming match"
            )}
          </dd>
        </div>
        {g.telegramConnected !== null && (
          <div className="flex items-center gap-2 sm:col-span-2">
            <dt className="sr-only">Telegram</dt>
            <MessageCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dd>{g.telegramConnected ? "Telegram group connected" : "Telegram not connected"}</dd>
          </div>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        <Link href={g.href} className={cn("inline-flex min-h-10 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90", focusRing)}>
          Open<span className="sr-only"> {g.name}</span>
        </Link>
        <Link href={g.matchesHref} className={cn("inline-flex min-h-10 items-center rounded-full border border-input px-4 text-sm font-semibold hover:bg-muted", focusRing)}>
          Matches<span className="sr-only"> in {g.name}</span>
        </Link>
        <Link href={g.playersHref} className={cn("inline-flex min-h-10 items-center rounded-full border border-input px-4 text-sm font-semibold hover:bg-muted", focusRing)}>
          Players<span className="sr-only"> in {g.name}</span>
        </Link>
        {canManage && (
          <Link href={`${g.href}/settings`} className={cn("inline-flex min-h-10 items-center gap-1.5 rounded-full border border-input px-4 text-sm font-semibold hover:bg-muted", focusRing)}>
            <Settings2 className="size-4" aria-hidden="true" /> Settings<span className="sr-only"> for {g.name}</span>
          </Link>
        )}
      </div>
    </li>
  );
}
