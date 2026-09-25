import { notFound } from "next/navigation";
import { loadPublicGroupLayoutData } from "./layout-data";

/**
 * Phase 2D.5D — subtree-wide gate for every canonical
 * /g/[organizationSlug]/[groupSlug]/* route.
 *
 * Deliberately renders NO header/chrome of its own. RootLayout
 * already renders the app's single SiteHeader instance,
 * unconditionally, for every route (it owns <html>/<body> and has no
 * way to know it's under a /g/... path — see Phase 2D.5D report §C
 * for the full reasoning). Adding a second header here would violate
 * the single-header requirement. Instead, SiteHeader itself becomes
 * aware it's on a canonical route via its own client-side pathname
 * (src/lib/canonicalGroupPath.ts) and fetches this Group's branding
 * independently. This layout's only job is the tenant-safety gate:
 * an invalid/mismatched/inactive Group 404s the entire subtree before
 * any nested page renders.
 */

type Params = Promise<{ organizationSlug: string; groupSlug: string }>;

export default async function PublicGroupLayout({
  params,
  children,
}: {
  params: Params;
  children: React.ReactNode;
}) {
  const { organizationSlug, groupSlug } = await params;

  const data = await loadPublicGroupLayoutData({ organizationSlug, groupSlug });
  if (!data) notFound();

  return <>{children}</>;
}
