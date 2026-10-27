import type { ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { trialBannerView } from "@/lib/trialBanner";
import { billingConfig } from "@/lib/billing/config";
import { effectivePlan, organizationTimeZone, supportEmail } from "@/lib/entitlements";
import { TrialBanner } from "@/components/billing/TrialBanner";
import { PlanLimitProvider, type PlanLimitViewer } from "@/components/billing/PlanLimitNotice";
import { billingPagePath } from "@/lib/billing/checkout";

/**
 * M11.3 — every Organization page (organization, groups, matches, players,
 * settings) shows the trial banner to OWNER/ADMIN while the trial is ending or
 * just ended. Read-only and best-effort: access is decided by each page itself
 * (this layout never authorizes, redirects or 404s — on any problem it renders
 * the page alone).
 *
 * Fix A — it also tells PlanLimitNotice who is looking (OWNER → an Upgrade to Pro
 * link to THIS organization's Billing page, only while billing is on; others →
 * "ask your owner"), so every plan-limit message offers the right next step.
 */
type Params = Promise<{ organizationSlug: string }>;

export default async function OrganizationLayout({ children, params }: { children: ReactNode; params: Params }) {
  const { organizationSlug } = await params;
  let banner = null;
  let viewer: PlanLimitViewer | null = null;
  try {
    const context = await requireOrganizationContextForSlug({ organizationSlug });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { slug: true, plan: true, trialEndsAt: true } });
    const billingEnabled = billingConfig().enabled;
    banner = trialBannerView(org, context.membership.role, new Date(), billingEnabled, await organizationTimeZone(context.organization.id));
    const isOwner = context.membership.role === "OWNER";
    viewer = { isOwner, billingEnabled, upgradeHref: isOwner && billingEnabled ? billingPagePath(org.slug) : null, plan: effectivePlan(org), supportEmail: supportEmail() };
  } catch (e) {
    unstable_rethrow(e); // Next.js control flow (dynamic rendering, redirects) is never swallowed
    banner = null;
    viewer = null;
  }
  return (
    <PlanLimitProvider value={viewer}>
      {banner && <TrialBanner view={banner} />}
      {children}
    </PlanLimitProvider>
  );
}
