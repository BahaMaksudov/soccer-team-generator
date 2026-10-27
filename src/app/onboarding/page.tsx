import Link from "next/link";
import { redirect } from "next/navigation";
import { listAccessibleTenants, requireSessionUser, TenantContextError } from "@/lib/tenantContext";
import { ownershipAllowance, ownershipCountLabel, ownershipLimitMessage, SECOND_ORGANIZATION_NOTE, TRIAL_POLICY_NOTE, trialAvailableFor, type OwnershipAllowance } from "@/lib/entitlements";
import { DEFAULT_TIMEZONE, SUPPORTED_SPORTS } from "@/lib/workspaces";
import OnboardingClient from "./OnboardingClient";

/**
 * M5 — create an Organization and its first Group. First-time users land
 * here from /admin (zero Organizations); existing users reach it via
 * "Create organization". Either way the server makes the session User
 * the OWNER (POST /api/admin/organizations).
 */
type Search = Promise<{ plan?: string | string[] }>;

export default async function OnboardingPage({ searchParams }: { searchParams: Search }) {
  // Pricing CTA (/upgrade): remember the chosen Pro interval through onboarding — only these two values.
  const rawPlan = (await searchParams).plan;
  const plan = rawPlan === "month" || rawPlan === "year" ? rawPlan : null;
  const self = plan ? `/onboarding?plan=${plan}` : "/onboarding";
  let organizationCount: number;
  let allowance: OwnershipAllowance;
  let trialAvailable: boolean;
  try {
    organizationCount = (await listAccessibleTenants()).length;
    // Phase 1 — display only; POST /api/admin/organizations enforces the allowance.
    const user = await requireSessionUser();
    allowance = await ownershipAllowance(user.id);
    trialAvailable = await trialAvailableFor(user.id); // M11.3 — display only
  } catch (e) {
    if (e instanceof TenantContextError) {
      // Organization creation requires a verified email (central rule in tenantContext).
      redirect(e.code === "EMAIL_NOT_VERIFIED" ? `/verify-email?next=${encodeURIComponent(self)}` : `/login?callbackUrl=${encodeURIComponent(self)}`);
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
      {trialAvailable && <p className="text-sm text-muted-foreground">{TRIAL_POLICY_NOTE}</p>}
      {plan && (
        <p role="status" className="rounded-tbp-md border border-primary/30 bg-primary/5 p-3 text-sm">
          Next, you&apos;ll choose <span className="font-semibold">{plan === "year" ? "Pro Yearly" : "Pro Monthly"}</span> on your new organization&apos;s Billing page. Nothing is charged until you confirm there.
        </p>
      )}
      {allowance.owned > 0 && (
        <p className="text-sm">
          <span className="font-semibold">{ownershipCountLabel(allowance)}.</span>{" "}
          <span className="text-muted-foreground">{allowance.canCreate ? SECOND_ORGANIZATION_NOTE : null}</span>
        </p>
      )}
      {allowance.canCreate ? (
        <div className="rounded-tbp-2xl border border-border bg-card p-5 shadow-card">
          <OnboardingClient sports={SUPPORTED_SPORTS.map((s) => ({ key: s.key, label: s.label }))} defaultTimezone={DEFAULT_TIMEZONE} plan={plan} />
        </div>
      ) : (
        <div role="status" className="rounded-tbp-2xl border border-border bg-card p-5 text-sm shadow-card">
          <p className="font-semibold">You can&apos;t create another organization right now.</p>
          <p className="mt-1 text-muted-foreground">{ownershipLimitMessage(allowance)}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        {organizationCount > 0 && (
          <Link className={link} href="/admin">
            Back to My Organizations
          </Link>
        )}
        <Link className={link} href="/account/security">
          Account
        </Link>
      </div>
    </div>
  );
}
