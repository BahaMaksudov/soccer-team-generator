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

  // UI-7 — inside the authenticated app shell (was the only first-run page left in legacy chrome).
  const link = "font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <header>
        <p className="eyebrow">{organizationCount === 0 ? "Get started" : "Organizations"}</p>
        <h1 className="mt-1 text-3xl font-extrabold">{organizationCount === 0 ? "Create your organization" : "Create another organization"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">An organization holds your groups. Each group has its own players, teams and settings.</p>
      </header>
      <div className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
        <OnboardingClient sports={SUPPORTED_SPORTS.map((s) => ({ key: s.key, label: s.label }))} defaultTimezone={DEFAULT_TIMEZONE} />
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {organizationCount > 0 && (
          <Link className={link} href="/admin">
            Back to your workspaces
          </Link>
        )}
        <Link className={link} href="/account/security">
          Account
        </Link>
      </div>
    </div>
  );
}
