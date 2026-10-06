import { redirect } from "next/navigation";
import { findSport } from "@/lib/sports";
import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ROLE_LABELS } from "@/lib/appShell";
import { listAccessibleTenants, TenantContextError, type AccessibleOrganization } from "@/lib/tenantContext";
import { resolveAdminEntry } from "./adminEntry";

/**
 * Phase 2D.6C — bare `/admin` is now the authenticated tenant-entry
 * point, not the operational application. The generator UI (formerly
 * here) now lives only in the canonical tenant-bound workspace
 * (/admin/o/[organizationSlug]/g/[groupSlug]); the legacy copy was
 * retired in Phase 2D.6D.5E.4 and deleted in 2D.6D.5E.5.
 *
 * Uses listAccessibleTenants() (Phase 2D.6B) — never the public
 * DEFAULT_PUBLIC_ORGANIZATION_SLUG/DEFAULT_PUBLIC_GROUP_SLUG
 * compatibility config, never a "first Organization"/"first Group"
 * query. The only case that auto-redirects is the objectively
 * unambiguous one; see ./adminEntry.ts for the exact decision rule.
 */
export default async function AdminEntryPage() {
  let organizations: AccessibleOrganization[];
  try {
    organizations = await listAccessibleTenants();
  } catch (e) {
    // Middleware already requires a session to reach this page; a
    // session that no longer maps to a User (e.g. deleted, or bound to
    // a different User.id) is sent back to sign in — fail closed.
    if (e instanceof TenantContextError) {
      redirect(e.code === "EMAIL_NOT_VERIFIED" ? "/verify-email" : "/login?callbackUrl=%2Fadmin");
    }
    throw e;
  }

  const entry = resolveAdminEntry(organizations);

  if (entry.kind === "redirect") {
    redirect(entry.href);
  }

  // M5: a signed-in User with no Organization yet starts onboarding.
  if (entry.kind === "no-access") {
    redirect("/onboarding");
  }

  const shown = entry.kind === "select" ? entry.organizations : [entry.organization];

  // UI-3 — redesigned presentation (app shell); same data, roles and links as before.
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Workspaces</p>
          <h1 className="mt-1 text-3xl font-extrabold">Your workspaces</h1>
          <p className="mt-1 text-muted-foreground">Choose a group to manage its players, matches and teams.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/onboarding">
            <Plus aria-hidden="true" />
            Create organization
          </Link>
        </Button>
      </div>

      {shown.map((org) => (
        <Card key={org.id}>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-tbp-sm bg-accent font-display font-black text-accent-foreground" aria-hidden="true">
                {org.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-extrabold">{org.name}</h2>
                <Badge variant="secondary">{ROLE_LABELS[org.role]}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(org.role === "OWNER" || org.role === "ADMIN") && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/admin/o/${encodeURIComponent(org.slug)}/groups/new`}>Add group</Link>
                </Button>
              )}
              {org.role === "OWNER" && (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/admin/o/${encodeURIComponent(org.slug)}/members`}>Members</Link>
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {org.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active groups.</p>
            ) : (
              <ul className="divide-y divide-border rounded-tbp border border-border">
                {org.groups.map((g) => (
                  <li key={g.id}>
                    <Link
                      className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      href={`/admin/o/${encodeURIComponent(org.slug)}/g/${encodeURIComponent(g.slug)}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-semibold">{g.name}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">{findSport(g.sportKey)?.label ?? g.sportKey}</span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
