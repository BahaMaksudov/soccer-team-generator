import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasOrgRole, requireOrganizationContextForSlug, TenantContextError } from "@/lib/tenantContext";
import { DEFAULT_TIMEZONE, GROUP_CREATOR_ROLES, SUPPORTED_SPORTS } from "@/lib/workspaces";
import AddGroupForm from "./AddGroupForm";

/**
 * M7 — Add Group to an existing Organization (OWNER/ADMIN). The
 * Organization comes from the URL slug verified against the session
 * User's membership; MEMBERs and non-members get the same 404.
 */
type Params = Promise<{ organizationSlug: string }>;

export default async function AddGroupPage({ params }: { params: Params }) {
  const { organizationSlug } = await params;
  let organization: { name: string; slug: string };
  try {
    const context = await requireOrganizationContextForSlug({ organizationSlug });
    if (!hasOrgRole(context, [...GROUP_CREATOR_ROLES])) notFound();
    organization = context.organization;
  } catch (e) {
    if (e instanceof TenantContextError) {
      if (e.code === "EMAIL_NOT_VERIFIED") redirect("/verify-email");
      notFound();
    }
    throw e;
  }

  // UI-5 — redesigned presentation; same OWNER/ADMIN gate and request.
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Link
        className="inline-flex min-h-10 items-center text-sm font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href={`/admin/o/${encodeURIComponent(organization.slug)}/groups`}
      >
        ← All groups
      </Link>
      <div className="space-y-4 rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <div>
          <p className="eyebrow">{organization.name}</p>
          <h1 className="mt-1 text-2xl font-extrabold">Create group</h1>
          <p className="mt-1 text-sm text-muted-foreground">A group is one recurring game with its own players and sport, e.g. &quot;Tuesday Basketball&quot;.</p>
        </div>
        <AddGroupForm organizationSlug={organization.slug} sports={SUPPORTED_SPORTS} defaultTimezone={DEFAULT_TIMEZONE} />
      </div>
    </div>
  );
}
