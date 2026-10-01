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

  return (
    <div className="rounded-2xl border bg-white shadow-sm p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{organizationName} — Members</h1>
        <Link className="text-sm underline" href="/admin">
          Switch workspace
        </Link>
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Members</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-4">Name</th>
                <th className="py-1 pr-4">Email</th>
                <th className="py-1">Role</th>
              </tr>
            </thead>
            <tbody>
              {view.members.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="py-1 pr-4">{m.name ?? "—"}</td>
                  <td className="py-1 pr-4">{m.email}</td>
                  <td className="py-1">{m.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Pending invitations</h2>
        {view.pendingInvitations.length === 0 ? (
          <p className="text-sm text-gray-500">No pending invitations.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {view.pendingInvitations.map((i) => (
              <li key={i.id}>
                {i.email} · {i.role} · expires {fmt(i.expiresAt)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Invite someone</h2>
        <InviteForm organizationSlug={slug} roles={[...INVITABLE_ROLES]} />
      </section>
    </div>
  );
}
