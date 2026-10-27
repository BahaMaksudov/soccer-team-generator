/**
 * Pricing CTA hand-off (/upgrade?plan=…) against the guarded local test DB.
 * Navigation only: it never creates a Checkout or calls Stripe — it routes the
 * visitor to sign-up / verification / onboarding / their OWN organization's
 * existing Billing page (which applies every purchase rule).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT ${url}`), { url });
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { prisma } from "@/lib/prisma";
import UpgradePage from "@/app/upgrade/page";
import OnboardingPage from "@/app/onboarding/page";
import * as signupRoute from "@/app/api/signup/route";
import * as verifyRoute from "@/app/api/verify-email/route";
import * as organizationsRoute from "@/app/api/admin/organizations/route";
import { setEmailTransportForTests, testOutbox } from "@/lib/email/transport";
import { billingView } from "@/lib/billing/checkout";
import { setBillingStripeForTests } from "@/lib/billing/stripe";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { TRIAL_DAYS } from "@/lib/entitlements";
import { createFakeStripe } from "./fakeStripe";

const BASE = "http://itest.local";
const post = (body: unknown) => new Request(`${BASE}/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const VERIFIED = new Date("2026-01-01T00:00:00Z");
const as = (who: string | null) => {
  session = who ? { user: { id: `u-${who}`, email: `${who}@example.test` } } : null;
};
/** Runs the page: returns the redirect target, or the rendered HTML. */
async function visit(plan?: string, org?: string): Promise<{ redirect: string } | { html: string }> {
  try {
    const el = await UpgradePage({ searchParams: Promise.resolve({ ...(plan === undefined ? {} : { plan }), ...(org === undefined ? {} : { org }) }) });
    return { html: renderToStaticMarkup(el) };
  } catch (e) {
    const url = (e as { url?: string }).url;
    if (url) return { redirect: url };
    throw e;
  }
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
});

beforeEach(async () => {
  session = null;
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("EMAIL_FROM", "TeamBalance Pro <no-reply@mail.teambalancepro.test>");
  testOutbox.clear();
  setEmailTransportForTests(null);
  await prisma.$executeRawUnsafe(`TRUNCATE "OrganizationMembership","Organization","User" RESTART IDENTITY CASCADE`);
  await prisma.user.createMany({
    data: [
      { id: "u-one", email: "one@example.test", name: "One", emailVerifiedAt: VERIFIED },
      { id: "u-two", email: "two@example.test", name: "Two", emailVerifiedAt: VERIFIED },
      { id: "u-none", email: "none@example.test", name: "None", emailVerifiedAt: VERIFIED },
      { id: "u-unverified", email: "unverified@example.test", name: "Unverified", emailVerifiedAt: null },
    ],
  });
  for (const [id, name] of [["org-a", "Alpha FC"], ["org-b", "Bravo FC"], ["org-c", "Charlie FC"], ["org-x", "Other Club"]]) {
    await prisma.organization.create({ data: { id, name, slug: id } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      { userId: "u-one", organizationId: "org-a", role: "OWNER" },
      { userId: "u-two", organizationId: "org-b", role: "OWNER" },
      { userId: "u-two", organizationId: "org-c", role: "OWNER" },
      { userId: "u-two", organizationId: "org-x", role: "ADMIN" }, // not an owner: never offered
      { userId: "u-none", organizationId: "org-x", role: "MEMBER" },
    ],
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  setBillingStripeForTests(null);
  await prisma.$disconnect();
});

describe("/upgrade — pricing CTA hand-off", () => {
  it("signed out → sign-up, coming back to the same plan afterwards (monthly by default; only month/year accepted)", async () => {
    as(null);
    expect(await visit("month")).toEqual({ redirect: `/signup?next=${encodeURIComponent("/upgrade?plan=month")}` });
    expect(await visit("year")).toEqual({ redirect: `/signup?next=${encodeURIComponent("/upgrade?plan=year")}` });
    expect(await visit()).toEqual({ redirect: `/signup?next=${encodeURIComponent("/upgrade?plan=month")}` });
    expect(await visit("lifetime")).toEqual({ redirect: `/signup?next=${encodeURIComponent("/upgrade?plan=month")}` });
  });

  it("unverified email → verification first, then back here", async () => {
    as("unverified");
    expect(await visit("year")).toEqual({ redirect: `/verify-email?next=${encodeURIComponent("/upgrade?plan=year")}` });
  });

  it("owns no organization (member elsewhere only) → onboarding, keeping the chosen plan", async () => {
    as("none");
    expect(await visit("year")).toEqual({ redirect: "/onboarding?plan=year" });
    expect(await visit("month")).toEqual({ redirect: "/onboarding?plan=month" });
  });

  it("?org= is honored ONLY for an organization the user owns (never an arbitrary path or another tenant)", async () => {
    as("two");
    expect(await visit("year", "org-c")).toEqual({ redirect: "/admin/o/org-c/billing?plan=year" });
    for (const bad of ["org-x" /* ADMIN only */, "org-a" /* another user's */, "../../evil", "https://evil.example", "//evil.example", ""]) {
      const r = await visit("year", bad);
      expect("html" in r, bad).toBe(true); // falls back to the chooser of OWN organizations
      if ("html" in r) expect(r.html, bad).not.toMatch(/evil|org-x|org-a/);
    }
    as("one");
    expect(await visit("month", "org-b")).toEqual({ redirect: "/admin/o/org-a/billing?plan=month" }); // not theirs → their own
  });

  it("owns one organization → its existing Billing page with the interval preselected", async () => {
    as("one");
    expect(await visit("year")).toEqual({ redirect: "/admin/o/org-a/billing?plan=year" });
    expect(await visit("month")).toEqual({ redirect: "/admin/o/org-a/billing?plan=month" });
  });

  it("owns several → a chooser listing ONLY the organizations they own (tenant isolation)", async () => {
    as("two");
    const r = await visit("year");
    if (!("html" in r)) throw new Error(`expected a page, got ${JSON.stringify(r)}`);
    expect(r.html).toContain("Choose the organization to upgrade");
    expect(r.html).toContain('href="/admin/o/org-b/billing?plan=year"');
    expect(r.html).toContain('href="/admin/o/org-c/billing?plan=year"');
    expect(r.html).not.toContain("org-x"); // ADMIN only — not offered
    expect(r.html).not.toContain("org-a"); // someone else's organization
    expect(r.html).not.toContain("Other Club");
  });

  it("never touches billing: no Checkout record is created", async () => {
    as("one");
    await visit("year");
    expect(await prisma.billingCheckoutSession.count()).toBe(0);
  });
});

describe("new visitor: pricing → sign-up → verification → onboarding → Billing (plan preserved)", () => {
  for (const plan of ["month", "year"] as const) {
    it(`Pro ${plan === "year" ? "Yearly" : "Monthly"}: lands on the new organization's Billing page with ${plan} preselected; trial kept; nothing charged`, async () => {
      // 1. Pricing button while signed out.
      as(null);
      const next = `/upgrade?plan=${plan}`;
      expect(await visit(plan)).toEqual({ redirect: `/signup?next=${encodeURIComponent(next)}` });
      // 2. Sign-up keeps `next`, and the verification email link carries it.
      const email = `new-${plan}@example.test`;
      const res = await signupRoute.POST(post({ name: "New Owner", email, password: "a-strong-password-1", confirmPassword: "a-strong-password-1", next }));
      expect(res.status).toBe(201);
      expect((await res.json()).next).toBe(next);
      const mail = [...testOutbox.sent].reverse().find((m) => m.to === email);
      const link = mail?.text.match(new RegExp(`${BASE}/verify-email/[A-Za-z0-9_-]{43}[^\\s]*`))?.[0] ?? "";
      expect(link).toContain(`next=${encodeURIComponent(next)}`);
      // 3. Verify (the button then goes to `next`).
      const token = link.match(/verify-email\/([A-Za-z0-9_-]{43})/)?.[1];
      expect((await verifyRoute.POST(post({ token }))).status).toBe(200);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerifiedAt).not.toBeNull();
      session = { user: { id: user.id, email } };
      // 4. Back at /upgrade with no organization → onboarding, plan kept.
      expect(await visit(plan)).toEqual({ redirect: `/onboarding?plan=${plan}` });
      const onboarding = renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve({ plan }) }));
      expect(onboarding).toContain(plan === "year" ? "Pro Yearly" : "Pro Monthly");
      expect(onboarding).toContain("Nothing is charged until you confirm there.");
      // 5. Create the organization (existing API) — it gets the existing 90-day trial.
      const created = await organizationsRoute.POST(post({ organizationName: `Club ${plan}`, groupName: "Sunday", sportKey: "soccer", timezone: "America/New_York" }));
      expect(created.status).toBe(201);
      const slug: string = (await created.json()).organization.slug;
      const org = await prisma.organization.findUniqueOrThrow({ where: { slug } });
      expect(org.plan).toBe("FREE");
      expect(Math.round((org.trialEndsAt!.getTime() - Date.now()) / 86_400_000)).toBe(TRIAL_DAYS);
      // 6. Onboarding continues to /upgrade?plan=…&org=<slug> → that organization's Billing page.
      expect(await visit(plan, slug)).toEqual({ redirect: `/admin/o/${slug}/billing?plan=${plan}` });
      // Refresh-safe: the same request redirects the same way; no Checkout or subscription was created.
      expect(await visit(plan, slug)).toEqual({ redirect: `/admin/o/${slug}/billing?plan=${plan}` });
      expect(await prisma.billingCheckoutSession.count()).toBe(0);
      expect(await prisma.billingSubscription.count()).toBe(0);
      // 7. Billing page eligibility (existing rules): the trial organization's owner may subscribe.
      vi.stubEnv("BILLING_ENABLED", "true");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_upgrade_flow_fake");
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_upgrade_flow_fake");
      vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_test_monthly");
      vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_test_annual");
      vi.stubEnv("VERCEL_ENV", "");
      const stripe = createFakeStripe();
      setBillingStripeForTests(stripe.api);
      const view = await billingView(await requireOrganizationContextForSlug({ organizationSlug: slug }));
      expect(view).toMatchObject({ billingEnabled: true, isOwner: true, canPurchase: true });
      expect(Object.keys(stripe.calls)).toEqual([]); // viewing Billing never calls Stripe
    });
  }

  it("an existing Pro subscriber is sent to Billing, where no second subscription is offered", async () => {
    as("one");
    await prisma.organization.update({ where: { id: "org-a" }, data: { plan: "PRO", stripeCustomerId: "cus_upgrade_existing" } });
    await prisma.billingSubscription.create({ data: { organizationId: "org-a", stripeSubscriptionId: "sub_upgrade_existing", stripeCustomerId: "cus_upgrade_existing", status: "active", livemode: false, lastSyncedAt: new Date() } });
    expect(await visit("year")).toEqual({ redirect: "/admin/o/org-a/billing?plan=year" });
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_upgrade_flow_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_upgrade_flow_fake");
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_test_monthly");
    vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_test_annual");
    vi.stubEnv("VERCEL_ENV", "");
    setBillingStripeForTests(createFakeStripe().api);
    const view = await billingView(await requireOrganizationContextForSlug({ organizationSlug: "org-a" }));
    expect(view).toMatchObject({ canPurchase: false, canManage: true });
  });
});
