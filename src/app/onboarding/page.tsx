import Link from "next/link";
import { redirect } from "next/navigation";
import { listAccessibleTenants, TenantContextError } from "@/lib/tenantContext";
import { DEFAULT_TIMEZONE, SUPPORTED_SPORTS } from "@/lib/workspaces";
import OnboardingClient from "./OnboardingClient";

/**
 * M5 — create an Organization and its first Group. First-time users land
 * here from /admin (zero Organizations); existing users reach it via
 * "Create organization". Either way the server makes the session User
 * the OWNER (POST /api/admin/organizations).
 */
export default async function OnboardingPage() {
  let organizationCount: number;
  try {
    organizationCount = (await listAccessibleTenants()).length;
  } catch (e) {
    if (e instanceof TenantContextError) {
      // Organization creation requires a verified email (central rule in tenantContext).
      redirect(e.code === "EMAIL_NOT_VERIFIED" ? "/verify-email?next=%2Fonboarding" : "/login?callbackUrl=%2Fonboarding");
    }
    throw e;
  }

  return (
    <div className="max-w-lg mx-auto rounded-2xl border bg-white shadow-sm p-5 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">
          {organizationCount === 0 ? "Create your organization" : "Create another organization"}
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          An organization holds your groups. Each group has its own players, teams and settings.
        </p>
      </div>
      <OnboardingClient sports={SUPPORTED_SPORTS.map((s) => ({ key: s.key, label: s.label }))} defaultTimezone={DEFAULT_TIMEZONE} />
      <div className="flex flex-wrap gap-4 text-sm">
        {organizationCount > 0 && (
          <Link className="underline" href="/admin">
            Back to your workspaces
          </Link>
        )}
        <Link className="underline" href="/account/security">
          Account
        </Link>
      </div>
    </div>
  );
}
