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

  return (
    <div className="max-w-lg mx-auto rounded-2xl border bg-white shadow-sm p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Add group — {organization.name}</h1>
        <Link className="text-sm underline" href="/admin">
          Back
        </Link>
      </div>
      <p className="text-sm text-gray-600">
        A group is one recurring game with its own players and sport, e.g. &quot;Tuesday Basketball&quot;.
      </p>
      <AddGroupForm organizationSlug={organization.slug} sports={SUPPORTED_SPORTS} defaultTimezone={DEFAULT_TIMEZONE} />
    </div>
  );
}
