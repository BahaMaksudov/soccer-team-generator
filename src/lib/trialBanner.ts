import type { OrganizationPlan, OrgRole } from "@prisma/client";
import { billingConfig } from "@/lib/billing/config";
import { trialDateLabel, trialStatus, upgradeHint } from "@/lib/entitlements";

/**
 * M11.3 — what the trial banner says (pure; unit-tested). OWNER/ADMIN only.
 *   ending  (≤ 14 days left)          → when it ends and what changes;
 *   expired (≤ 30 days after the end) → Free plan, why Telegram is off, nothing deleted;
 *   otherwise                          → no banner (the Plan & usage card still explains).
 * The Upgrade action appears only when billing is enabled, and only for the OWNER
 * (the Billing page's upgrade is OWNER-only). Dates are shown in the organization's
 * timezone (organizationTimeZone); the end instant itself is UTC.
 */
export const EXPIRED_BANNER_DAYS = 30;
export type TrialBannerView = { phase: "ending" | "expired"; title: string; body: string; hint: string | null; upgradeHref: string | null };

export function trialBannerView(
  org: { slug: string; plan: OrganizationPlan; trialEndsAt: Date | null },
  role: OrgRole,
  now: Date = new Date(),
  billingEnabled: boolean = billingConfig().enabled,
  timeZone: string = "UTC"
): TrialBannerView | null {
  if (role !== "OWNER" && role !== "ADMIN") return null;
  const t = trialStatus(org, now);
  if (!t.endsAt) return null;
  const upgradeHref = billingEnabled && role === "OWNER" ? `/admin/o/${encodeURIComponent(org.slug)}/billing` : null;
  const hint = billingEnabled ? (role === "OWNER" ? null : "The organization owner can upgrade to Pro on the Billing page.") : upgradeHint();
  const date = trialDateLabel(t.endsAt, timeZone);
  if (t.phase === "ending") {
    const when = t.daysLeft === 1 ? "in less than a day" : `in ${t.daysLeft} days`;
    return {
      phase: "ending",
      title: `Your Pro trial ends ${when} (${date}).`,
      body: "Afterwards this organization moves to the Free plan automatically: Telegram polls, team posts, match messages and Game Day Updates stop, and Free limits apply. Nothing is charged and nothing is deleted.",
      hint,
      upgradeHref,
    };
  }
  if (t.phase === "expired" && now.getTime() - t.endsAt.getTime() <= EXPIRED_BANNER_DAYS * 86_400_000) {
    return {
      phase: "expired",
      title: `Your Pro trial ended on ${date}. This organization is on the Free plan.`,
      body: "Telegram polls, team posts, match messages and Game Day Updates are off on Free. Players can still answer through the match link, and all players, matches, history and connected Telegram groups are kept.",
      hint,
      upgradeHref,
    };
  }
  return null;
}
