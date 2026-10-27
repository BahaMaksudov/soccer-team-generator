import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireSessionUser, TenantContextError } from "@/lib/tenantContext";
import { billingPagePath } from "@/lib/billing/checkout";

/**
 * Pricing CTA hand-off ("Get Pro Monthly / Yearly"). Navigation ONLY — nothing
 * is purchased here and no Stripe call is made:
 *  - signed out      → sign up, then come back here (sign-in keeps it too);
 *  - unverified      → verify email, then come back here;
 *  - owns 0 orgs     → onboarding (create the organization first), which returns here with
 *                      ?org=<new slug> once it exists;
 *  - ?org=<slug>     → that organization's Billing page — ONLY if the user owns it (else ignored);
 *  - owns 1 org      → that organization's existing Billing page, interval preselected;
 *  - owns 2+ orgs    → choose which organization to upgrade.
 * The Billing page applies every existing rule (OWNER only, FREE / trial only,
 * an existing subscription is never sold twice, terms + US address, Stripe Checkout).
 */
export const dynamic = "force-dynamic";

type Search = Promise<{ plan?: string; org?: string }>;

export default async function UpgradePage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const plan = sp.plan === "year" ? "year" : "month";
  const self = `/upgrade?plan=${plan}`;

  let userId: string;
  try {
    userId = (await requireSessionUser()).id;
  } catch (e) {
    if (e instanceof TenantContextError && e.code === "EMAIL_NOT_VERIFIED") redirect(`/verify-email?next=${encodeURIComponent(self)}`);
    redirect(`/signup?next=${encodeURIComponent(self)}`);
  }

  const owned = await prisma.organizationMembership.findMany({
    where: { userId, role: "OWNER" },
    select: { organization: { select: { slug: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (owned.length === 0) redirect(`/onboarding?plan=${plan}`);
  // Coming back from onboarding: the organization just created (only one the user owns — never an arbitrary path).
  const chosen = typeof sp.org === "string" ? owned.find(({ organization }) => organization.slug === sp.org) : undefined;
  if (chosen) redirect(`${billingPagePath(chosen.organization.slug)}?plan=${plan}`);
  if (owned.length === 1) redirect(`${billingPagePath(owned[0].organization.slug)}?plan=${plan}`);

  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-2xl border bg-white/90 p-6 shadow">
      <h1 className="text-xl font-bold">Choose the organization to upgrade</h1>
      <p className="text-sm text-slate-600">Pro is billed per organization. Pick the one you want to upgrade ({plan === "year" ? "Pro Yearly" : "Pro Monthly"}).</p>
      <ul className="space-y-2">
        {owned.map(({ organization: o }) => (
          <li key={o.slug}>
            <Link href={`${billingPagePath(o.slug)}?plan=${plan}`} className="block rounded-xl border px-4 py-3 font-semibold hover:bg-slate-50">
              {o.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
