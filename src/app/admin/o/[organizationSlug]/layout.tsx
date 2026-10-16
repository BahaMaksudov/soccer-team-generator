import type { ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { trialBannerView } from "@/lib/trialBanner";
import { TrialBanner } from "@/components/billing/TrialBanner";

/**
 * M11.3 — every Organization page (organization, groups, matches, players,
 * settings) shows the trial banner to OWNER/ADMIN while the trial is ending or
 * just ended. Read-only and best-effort: access is decided by each page itself
 * (this layout never authorizes, redirects or 404s — on any problem it renders
 * the page alone).
 */
type Params = Promise<{ organizationSlug: string }>;

export default async function OrganizationLayout({ children, params }: { children: ReactNode; params: Params }) {
  const { organizationSlug } = await params;
  let banner = null;
  try {
    const context = await requireOrganizationContextForSlug({ organizationSlug });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: context.organization.id }, select: { slug: true, plan: true, trialEndsAt: true } });
    banner = trialBannerView(org, context.membership.role);
  } catch (e) {
    unstable_rethrow(e); // Next.js control flow (dynamic rendering, redirects) is never swallowed
    banner = null;
  }
  return (
    <>
      {banner && <TrialBanner view={banner} />}
      {children}
    </>
  );
}
