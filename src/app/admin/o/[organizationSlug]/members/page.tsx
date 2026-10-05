import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireOrganizationContextForSlug, TenantContextError } from "@/lib/tenantContext";
import { INVITABLE_ROLES, listOrganizationMembers, type OrganizationMembersView } from "@/lib/invitations";
import InviteForm from "./InviteForm";

/**
 * M5 — OWNER-only Organization members and invitations. The
 * Organization comes from the URL slug, verified against the session
 * User's own membership; non-members and non-OWNERs get the same 404.
 * Member removal / ownership transfer are deferred (not implemented).
 */
type Params = Promise<{ organizationSlug: string }>;

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export default async function OrganizationMembersPage({ params }: { params: Params }) {
  const { organizationSlug } = await params;

  let organizationName: string;
  let slug: string;
  let view: OrganizationMembersView;
  try {
    const context = await requireOrganizationContextForSlug({ organizationSlug });
    view = await listOrganizationMembers(context);
    organizationName = context.organization.name;
    slug = context.organization.slug;
  } catch (e) {
    if (e instanceof TenantContextError) {
      if (e.code === "EMAIL_NOT_VERIFIED") redirect("/verify-email");
      notFound();
    }
    throw e;
  }

  // UI-6 — redesigned presentation; same OWNER-only data and invitation flow.
  const card = "rounded-tbp-2xl border border-border bg-card p-5 shadow-card";
  return (
    <div className="space-y-6">
      <Link className="inline-flex min-h-10 items-center text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/admin/o/${encodeURIComponent(slug)}`}>
        ← {organizationName}
      </Link>
      <header>
        <p className="eyebrow">{organizationName}</p>
        <h1 className="mt-1 text-3xl font-extrabold">Members</h1>
      </header>

      <section aria-labelledby="members-h" className={card}>
        <h2 id="members-h" className="mb-3 text-lg font-extrabold">Members</h2>
        <ul className="divide-y divide-border">
          {view.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0 text-sm">
              <span className="min-w-0">
                <span className="block font-semibold">{m.name ?? "—"}</span>
                <span className="block break-all text-xs text-muted-foreground">{m.email}</span>
              </span>
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold text-secondary-foreground">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pending-h" className={card}>
        <h2 id="pending-h" className="mb-3 text-lg font-extrabold">Pending invitations</h2>
        {view.pendingInvitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending invitations.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {view.pendingInvitations.map((i) => (
              <li key={i.id} className="break-all">
                {i.email} · {i.role} · expires {fmt(i.expiresAt)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="invite-h" className={card}>
        <h2 id="invite-h" className="mb-3 text-lg font-extrabold">Invite someone</h2>
        <InviteForm organizationSlug={slug} roles={[...INVITABLE_ROLES]} />
      </section>
    </div>
  );
}
