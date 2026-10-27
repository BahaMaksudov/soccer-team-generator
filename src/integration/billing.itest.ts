/**
 * M11.2A / M11.2B — Stripe billing (TEST MODE, and LIVE MODE in simulated Production), REAL DATABASE (guarded local test DB
 * only) with a FAKE Stripe adapter: no network call of any kind is made
 * (global fetch is a tripwire). Webhook signatures use the real Stripe SDK's
 * offline signing helpers with a test secret.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Live mode also needs the billing terms published (no pending billing-launch owner item); tests choose.
const legal = vi.hoisted(() => ({ items: [] as Array<{ id: string; label: string; category: "publication" | "legal-review" | "billing-launch" }> }));
vi.mock("@/lib/legal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/legal")>();
  return {
    ...actual,
    get OWNER_ITEMS() {
      return legal.items;
    },
  };
});
const PENDING_BILLING_TERMS = { id: "billing-terms", category: "billing-launch" as const, label: "billing terms" };

import { prisma } from "@/lib/prisma";
import * as billingRoute from "@/app/api/admin/o/[organizationSlug]/billing/route";
import * as checkoutRoute from "@/app/api/admin/o/[organizationSlug]/billing/checkout/route";
import * as portalRoute from "@/app/api/admin/o/[organizationSlug]/billing/portal/route";
import * as webhookRoute from "@/app/api/stripe/webhook/route";
import * as reconcileRoute from "@/app/api/cron/billing-reconcile/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import { setBillingStripeForTests, generateTestSignature } from "@/lib/billing/stripe";
import { resetPriceCheckCacheForTests } from "@/lib/billing/prices";
import { resetTaxCheckCacheForTests } from "@/lib/billing/tax";
import { chargeNotice, confirmCheckoutReturn } from "@/lib/billing/checkout";
import { reconcileBilling, syncSubscription } from "@/lib/billing/sync";
import { assertTelegram, organizationPlan, ownershipAllowance, PLAN_LIMITS, planSummary } from "@/lib/entitlements";
import { runTrialLifecycle } from "@/lib/trialLifecycle";
import { testOutbox } from "@/lib/email/transport";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { createFakeStripe, type FakeStripe } from "./fakeStripe";

const WHSEC = "whsec_test_m112a_integration_secret";
/** Syntactically valid, obviously fake live key — the fake adapter never sends it anywhere. */
const FAKE_LIVE_KEY = "sk_live_" + "FAKE0000000000000000000000000000";
const PRICES = { month: "price_test_monthly", year: "price_test_annual" };
const VERIFIED = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
let stripe: FakeStripe;
let otherNetwork = 0;
const originalFetch = global.fetch;

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://itest.local/", { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const call = async (res: Promise<Response> | Response) => {
  const r = await res;
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
const signIn = async (who: string | null) => {
  if (!who) return void (session = null);
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `${who}@example.test` } });
  session = { user: { id: u.id, email: u.email } };
};
const o = (org: string) => ({ params: Promise.resolve({ organizationSlug: org }) });
/** M11.2C — a valid US billing address; every checkout sends it and the Terms agreement unless a test overrides them. */
const US_ADDRESS = { line1: "1 Main St", line2: "", city: "Boston", state: "MA", postal_code: "02108", country: "US" };
const checkout = (org: string, body: Record<string, unknown> = { interval: "month" }) => call(checkoutRoute.POST(json("POST", { address: US_ADDRESS, acceptTerms: true, ...body }), o(org)));
const portal = (org: string) => call(portalRoute.POST(json("POST"), o(org)));
const view = (org: string) => call(billingRoute.GET(json("GET"), o(org)));
let evtSeq = 0;
/** A Stripe-signed webhook delivery (real SDK signing, test secret). */
function webhook(type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string; livemode?: boolean; signature?: string } = {}) {
  const payload = JSON.stringify({ id: opts.id ?? `evt_test_${++evtSeq}`, object: "event", type, livemode: opts.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object }, api_version: "2026-09-30.endive" });
  const signature = opts.signature ?? generateTestSignature(payload, opts.secret ?? WHSEC);
  return call(webhookRoute.POST(new Request("http://itest.local/api/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signature }, body: payload })));
}
const plan = async (org: string) => (await prisma.organization.findUniqueOrThrow({ where: { id: org }, select: { plan: true } })).plan;

const ORGS = { free: "FREE", trial: "FREE", legacy: "LEGACY", comp: "COMP", other: "FREE" } as const;

async function seed() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "StripeEvent","BillingCheckoutSession","BillingSubscription","EntitlementEvent","AiUsage","MatchSchedule","Match","CommunityPlayer","Community","Player","GroupSetting","Group","OrganizationMembership","OrganizationInvitation","EmailVerificationToken","Organization","User" RESTART IDENTITY CASCADE`
  );
  await prisma.user.createMany({ data: ["owner", "admin", "member", "other", "newbie"].map((n) => ({ id: `u-${n}`, email: `${n}@example.test`, name: n, passwordHash: null, emailVerifiedAt: VERIFIED })) });
  for (const [org, p] of Object.entries(ORGS)) {
    await prisma.organization.create({ data: { id: org, name: `Org ${org}`, slug: org, plan: p, trialEndsAt: org === "trial" ? new Date(Date.now() + 40 * DAY) : null } });
    await prisma.group.create({ data: { id: `${org}-g`, organizationId: org, name: `${org} group`, slug: `${org}-g`, sportKey: "soccer", timezone: "UTC" } });
  }
  await prisma.organizationMembership.createMany({
    data: [
      ...["free", "trial", "legacy", "comp"].flatMap((org) => [
        { userId: "u-owner", organizationId: org, role: "OWNER" as const },
        { userId: "u-admin", organizationId: org, role: "ADMIN" as const },
        { userId: "u-member", organizationId: org, role: "MEMBER" as const },
      ]),
      { userId: "u-other", organizationId: "other", role: "OWNER" },
    ],
  });
}

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
  global.fetch = (async () => {
    otherNetwork++;
    throw new Error("network access is forbidden in integration tests");
  }) as typeof fetch;
  vi.stubEnv("APP_BASE_URL", "http://itest.local");
  vi.stubEnv("CRON_SECRET", "billing-reconcile-test-secret");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
beforeEach(async () => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_m112a_fake_key");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", PRICES.month);
  vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", PRICES.year);
  vi.stubEnv("BILLING_ALLOW_LIVE_MODE", "");
  vi.stubEnv("VERCEL_ENV", ""); // local development unless a test says otherwise
  stripe = createFakeStripe();
  setBillingStripeForTests(stripe.api);
  resetPriceCheckCacheForTests();
  resetTaxCheckCacheForTests();
  legal.items = [];
  otherNetwork = 0;
  session = null;
  await seed();
  await signIn("owner");
});
afterEach(() => setBillingStripeForTests(null));
afterAll(async () => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

/** Owner checks out and pays; returns the subscription id (no webhook yet). */
async function subscribe(org: string, interval: "month" | "year" = "month", status = "active") {
  await signIn("owner");
  const r = await checkout(org, { interval });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const sessionId = String(r.body.url).split("/").pop()!;
  return { sessionId, sub: stripe.completeCheckout(sessionId, status) };
}

// ============================================================ CONFIGURATION SAFETY
describe("M11.2A — billing stays off unless explicitly enabled in TEST mode", () => {
  it("disabled by default: Checkout / Portal / webhook / reconcile refuse; the view says unavailable; no Stripe call", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect(await checkout("free")).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
    expect((await portal("free")).status).toBe(503);
    expect((await webhook("customer.subscription.updated", { id: "sub_x" })).status).toBe(503);
    expect((await call(reconcileRoute.POST(new Request("http://itest.local/", { method: "POST", headers: { authorization: "Bearer billing-reconcile-test-secret" } })))).status).toBe(503);
    expect((await view("free")).body).toMatchObject({ billingEnabled: false, canPurchase: false, canManage: false });
    expect(Object.keys(stripe.calls)).toEqual([]);
  });

  it("a LIVE key is rejected outside Production even with BILLING_ALLOW_LIVE_MODE=true (Development and Preview)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", FAKE_LIVE_KEY);
    vi.stubEnv("BILLING_ALLOW_LIVE_MODE", "true");
    for (const env of ["", "development", "preview"]) {
      vi.stubEnv("VERCEL_ENV", env);
      expect((await checkout("free")).status, env).toBe(503);
      expect((await portal("free")).status, env).toBe(503);
      expect((await webhook("customer.subscription.updated", { id: "sub_x" }, { livemode: true })).status, env).toBe(503);
      expect((await view("free")).body.billingEnabled, env).toBe(false);
    }
    expect(Object.keys(stripe.calls)).toEqual([]);
  });
});

describe("Production safety guard — Stripe TEST mode never runs in Vercel Production", () => {
  it("Preview with the configured test key: Checkout works", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await view("free")).body).toMatchObject({ billingEnabled: true, canPurchase: true });
    expect((await checkout("free")).status).toBe(200);
  });

  it("Production with a test key and BILLING_ENABLED=true: Checkout, Portal, return, webhook, sync and reconciliation all refuse; nothing written", async () => {
    // A paid test-mode subscription exists in Stripe (made in Preview) — Production must never apply it.
    vi.stubEnv("VERCEL_ENV", "preview");
    const { sessionId, sub } = await subscribe("free");
    const callsBefore = JSON.stringify(stripe.calls);
    vi.stubEnv("VERCEL_ENV", "production");

    expect(await checkout("free")).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
    expect((await portal("free")).status).toBe(503);
    expect((await view("free")).body).toMatchObject({ billingEnabled: false, canPurchase: false, canManage: false });
    expect(await confirmCheckoutReturn(await requireOrganizationContextForSlug({ organizationSlug: "free" }), sessionId)).toBe("ignored");
    expect((await webhook("customer.subscription.updated", { id: sub.id })).status).toBe(503);
    expect((await webhook("checkout.session.completed", { id: sessionId, subscription: sub.id })).status).toBe(503);
    await expect(syncSubscription(sub.id, { actor: "itest" })).rejects.toThrow("Billing is not enabled.");
    expect((await call(reconcileRoute.POST(new Request("http://itest.local/", { method: "POST", headers: { authorization: "Bearer billing-reconcile-test-secret" } })))).status).toBe(503);

    expect(await plan("free")).toBe("FREE");
    expect(await prisma.billingSubscription.count()).toBe(0);
    expect(await prisma.stripeEvent.count()).toBe(0);
    expect(JSON.stringify(stripe.calls)).toBe(callsBefore); // no further Stripe call
  });

  it("Production with billing disabled: no billing actions at all", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BILLING_ENABLED", "");
    expect((await checkout("free")).status).toBe(503);
    expect((await portal("free")).status).toBe(503);
    expect((await webhook("customer.subscription.updated", { id: "sub_x" })).status).toBe(503);
    expect(Object.keys(stripe.calls)).toEqual([]);
  });

  it("Production with a malformed live key: rejected", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("BILLING_ALLOW_LIVE_MODE", "true");
    expect((await checkout("free")).status).toBe(503);
    expect((await webhook("customer.subscription.updated", { id: "sub_x" }, { livemode: true })).status).toBe(503);
    expect(Object.keys(stripe.calls)).toEqual([]);
  });
});

// ============================================================ AUTHORIZATION + CHECKOUT
describe("M11.2A — Checkout", () => {
  it("OWNER only (ADMIN, MEMBER, other tenants → the generic 404); ADMIN can view status read-only; MEMBER cannot", async () => {
    await signIn("admin");
    expect((await checkout("free")).status).toBe(404);
    expect((await portal("free")).status).toBe(404);
    expect((await view("free")).body).toMatchObject({ isOwner: false, canPurchase: false, canManage: false });
    await signIn("member");
    expect((await checkout("free")).status).toBe(404);
    expect((await view("free")).status).toBe(404);
    await signIn("other");
    expect((await checkout("free")).status).toBe(404);
    expect((await view("free")).status).toBe(404);
    expect(Object.keys(stripe.calls)).toEqual([]);
  });

  it("the browser chooses only the interval: the Price, Organization and URLs come from the server", async () => {
    expect((await checkout("free", { interval: "weekly" })).status).toBe(400);
    expect((await checkout("free", { priceId: PRICES.month })).status).toBe(400);
    const r = await checkout("free", { interval: "year", priceId: "price_attacker", organizationId: "other", success_url: "https://evil.example" });
    expect(r.status).toBe(200);
    const s = [...stripe.sessions.values()][0];
    expect(s.price).toBe(PRICES.year);
    expect(s.params).toMatchObject({
      mode: "subscription",
      client_reference_id: "free",
      metadata: { organizationId: "free" },
      subscription_data: { metadata: { organizationId: "free" } },
      success_url: "http://itest.local/admin/o/free/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://itest.local/admin/o/free/billing?checkout=cancel",
      allow_promotion_codes: false,
    });
    expect(String((s.params.custom_text as { submit: { message: string } }).submit.message)).toBe(chargeNotice("year"));
    expect(s.params.line_items).toEqual([{ price: PRICES.year, quantity: 1 }]);
  });

  it("LEGACY and COMP are not offered Checkout (409, no Stripe call); PRO / live subscription → 409", async () => {
    for (const org of ["legacy", "comp"]) expect(await checkout(org)).toMatchObject({ status: 409, body: { code: "NOT_ELIGIBLE" } });
    expect(Object.keys(stripe.calls)).toEqual([]);
    const { sub } = await subscribe("free");
    await webhook("customer.subscription.created", { id: sub.id });
    expect(await checkout("free")).toMatchObject({ status: 409, body: { code: "ALREADY_SUBSCRIBED" } });
  });

  it("simultaneous clicks: one Stripe Customer, one Checkout Session, the same URL for everyone", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => checkout("free")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.url)).size).toBe(1);
    expect(stripe.customers.size).toBe(1);
    expect(stripe.sessions.size).toBe(1);
    expect(await prisma.billingCheckoutSession.count({ where: { organizationId: "free" } })).toBe(1);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: "free" } })).stripeCustomerId).toBe([...stripe.customers.keys()][0]);
  });

  it("Stripe outage, and a crash after Stripe created the session: the retry returns the SAME session (durable operation + idempotency key)", async () => {
    stripe.failNext.createCheckoutSession = "outage";
    expect(await checkout("free")).toMatchObject({ status: 503, body: { code: "STRIPE_UNAVAILABLE" } });
    expect(stripe.sessions.size).toBe(0);
    stripe.failNext.createCheckoutSession = "lost_response"; // Stripe created it, the response never arrived
    expect((await checkout("free")).status).toBe(503);
    expect(stripe.sessions.size).toBe(1);
    expect((await prisma.billingCheckoutSession.findFirstOrThrow()).status).toBe("CREATING");
    const retry = await checkout("free");
    expect(retry.status).toBe(200);
    expect(stripe.sessions.size).toBe(1);
    expect(retry.body.url).toBe([...stripe.sessions.values()][0].url);
    expect((await prisma.billingCheckoutSession.findFirstOrThrow()).status).toBe("OPEN");
    // A lost Customer response is recovered the same way.
    stripe.failNext.createCustomer = "lost_response";
    await signIn("other");
    expect((await checkout("other")).status).toBe(503);
    expect((await checkout("other")).status).toBe(200);
    expect([...stripe.customers.values()].filter((c) => c.metadata.organizationId === "other")).toHaveLength(1);
  });

  it("switching monthly → annual expires the open monthly session first (never two payable sessions); a just-completed one blocks", async () => {
    const m = await checkout("free", { interval: "month" });
    const y = await checkout("free", { interval: "year" });
    expect(y.status).toBe(200);
    const monthly = [...stripe.sessions.values()].find((s) => s.price === PRICES.month)!;
    expect(monthly.status).toBe("expired");
    expect(String(m.body.url)).toContain(monthly.id);
    expect((await prisma.billingCheckoutSession.findFirstOrThrow({ where: { stripeSessionId: monthly.id } })).status).toBe("EXPIRED");
    // The annual session gets paid; asking for monthly now must not open a second one.
    stripe.completeCheckout([...stripe.sessions.values()].find((s) => s.price === PRICES.year)!.id);
    expect(await checkout("free", { interval: "month" })).toMatchObject({ status: 409, body: { code: "ALREADY_SUBSCRIBED" } });
    expect(await plan("free")).toBe("PRO"); // applied from Stripe's real state on the way
  });
});

// ============================================================ WEBHOOKS
describe("M11.2A — webhooks", () => {
  it("forged, wrong-secret and wrong-mode deliveries are rejected and change nothing", async () => {
    const { sub } = await subscribe("free");
    expect((await webhook("customer.subscription.created", { id: sub.id }, { signature: "t=1,v1=deadbeef" })).status).toBe(400);
    expect((await webhook("customer.subscription.created", { id: sub.id }, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await webhook("customer.subscription.created", { id: sub.id }, { livemode: true })).status).toBe(400);
    expect(await plan("free")).toBe("FREE");
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it("Checkout success WITHOUT the browser redirect: the webhook alone activates PRO (audited), exactly once for duplicates", async () => {
    const { sessionId, sub } = await subscribe("free");
    const r = await webhook("checkout.session.completed", { id: sessionId, subscription: sub.id }, { id: "evt_completed" });
    expect(r).toMatchObject({ status: 200, body: { received: true } });
    expect(await plan("free")).toBe("PRO");
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_completed" } })).toMatchObject({ status: "PROCESSED", organizationId: "free", objectId: sub.id });
    expect(await prisma.billingCheckoutSession.findFirstOrThrow({ where: { stripeSessionId: sessionId } })).toMatchObject({ status: "COMPLETED" });
    expect(await prisma.billingSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: sub.id } })).toMatchObject({ status: "active", interval: "month", stripePriceId: PRICES.month, organizationId: "free" });
    const dup = await webhook("checkout.session.completed", { id: sessionId, subscription: sub.id }, { id: "evt_completed" });
    expect(dup.body).toMatchObject({ duplicate: true });
    await webhook("customer.subscription.created", { id: sub.id }); // a different event for the same state
    expect(await prisma.entitlementEvent.count({ where: { organizationId: "free", action: "STRIPE_PRO_STARTED" } })).toBe(1);
  });

  it("the browser redirect WITHOUT confirmed payment activates nothing; a foreign session id is ignored", async () => {
    await signIn("owner");
    const r = await checkout("free");
    const sessionId = String(r.body.url).split("/").pop()!;
    const ctx = await requireOrganizationContextForSlug({ organizationSlug: "free" });
    expect(await confirmCheckoutReturn(ctx, sessionId)).toBe("pending"); // not paid yet
    expect(await plan("free")).toBe("FREE");
    await signIn("other");
    const otherSession = String((await checkout("other")).body.url).split("/").pop()!;
    stripe.completeCheckout(otherSession);
    expect(await confirmCheckoutReturn(ctx, otherSession)).toBe("ignored"); // another Organization's session
    expect(await plan("free")).toBe("FREE");
    stripe.completeCheckout(sessionId);
    expect(await confirmCheckoutReturn(ctx, sessionId)).toBe("applied"); // verified with Stripe
    expect(await plan("free")).toBe("PRO");
  });

  it("out-of-order events converge on Stripe's CURRENT state (a stale 'active' event after cancellation keeps FREE)", async () => {
    const { sub } = await subscribe("free");
    await webhook("customer.subscription.created", { id: sub.id, status: "active" });
    stripe.updateSubscription(sub.id, { status: "canceled", ended_at: Math.floor(Date.now() / 1000) });
    await webhook("customer.subscription.deleted", { id: sub.id, status: "canceled" });
    expect(await plan("free")).toBe("FREE");
    await webhook("customer.subscription.updated", { id: sub.id, status: "active" }); // arrives late, payload is stale
    expect(await plan("free")).toBe("FREE");
  });

  it("Stripe outage while processing: 500 + FAILED (Stripe retries), nothing applied; the retry succeeds", async () => {
    const { sub } = await subscribe("free");
    stripe.failNext.retrieveSubscription = "outage";
    expect((await webhook("customer.subscription.created", { id: sub.id }, { id: "evt_retry" })).status).toBe(500);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_retry" } })).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(await plan("free")).toBe("FREE");
    expect((await webhook("customer.subscription.created", { id: sub.id }, { id: "evt_retry" })).status).toBe(200);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_retry" } })).toMatchObject({ status: "PROCESSED", attempts: 2 });
    expect(await plan("free")).toBe("PRO");
  });

  it("unmatched / inconsistent subscriptions become an operator EXCEPTION (never discarded); reconciliation recovers them", async () => {
    await prisma.organization.update({ where: { id: "free" }, data: { stripeCustomerId: "cus_real" } });
    stripe.addSubscription({ id: "sub_wrong_customer", customer: "cus_someone_else", status: "active", cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: { organizationId: "free" }, items: { data: [{ price: { id: PRICES.month }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] } });
    stripe.addSubscription({ id: "sub_no_org", customer: "cus_real", status: "active", cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: {}, items: { data: [{ price: { id: PRICES.month }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] } });
    expect((await webhook("customer.subscription.created", { id: "sub_wrong_customer" }, { id: "evt_x1" })).body).toMatchObject({ exception: true });
    expect((await webhook("customer.subscription.created", { id: "sub_no_org" }, { id: "evt_x2" })).body).toMatchObject({ exception: true });
    expect(await prisma.stripeEvent.findMany({ where: { status: "EXCEPTION" }, select: { id: true } })).toHaveLength(2);
    expect(await plan("free")).toBe("FREE");
    // The operator fixes the metadata in Stripe; reconciliation re-applies from Stripe.
    stripe.updateSubscription("sub_no_org", { metadata: { organizationId: "free" } });
    const r = await reconcileBilling();
    expect(r.eventsRecovered).toBeGreaterThanOrEqual(1);
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_x2" } })).toMatchObject({ status: "PROCESSED" });
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_x1" } })).toMatchObject({ status: "EXCEPTION" }); // still wrong → still visible
    expect(await plan("free")).toBe("PRO");
  });
});

// ============================================================ LIFECYCLE
describe("M11.2A — subscription lifecycle → entitlements", () => {
  it("active → past_due (grace) → recovered → cancel at period end → canceled → FREE; nothing deleted, Free limits apply", async () => {
    await prisma.player.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ id: `fp${i}`, groupId: "free-g", firstName: `P${i}`, lastName: "T", position: "MIDFIELDER", rating: "GOOD" as const, stamina: 3 })) });
    const { sub } = await subscribe("free");
    const step = async (patch: Parameters<FakeStripe["updateSubscription"]>[1], type = "customer.subscription.updated") => {
      stripe.updateSubscription(sub.id, patch);
      // Invoice events carry the subscription under parent.subscription_details (API 2026-09-30).
      const object = type.startsWith("invoice.") ? { id: `in_${type}`, parent: { subscription_details: { subscription: sub.id } } } : { id: sub.id };
      const r = await webhook(type, object);
      expect(r.status).toBe(200);
      expect(r.body.ignored).toBeUndefined();
      return plan("free");
    };
    expect(await step({ status: "active" }, "customer.subscription.created")).toBe("PRO");
    expect(await step({ status: "past_due" }, "invoice.payment_failed")).toBe("PRO"); // grace while Stripe retries
    expect((await view("free")).body.subscription).toMatchObject({ status: "past_due" });
    expect(await step({ status: "active" }, "invoice.paid")).toBe("PRO"); // recovered
    expect(await step({ cancel_at_period_end: true })).toBe("PRO"); // until the period ends
    expect((await view("free")).body.subscription).toMatchObject({ cancelAtPeriodEnd: true });
    expect(await step({ status: "canceled", ended_at: Math.floor(Date.now() / 1000) }, "customer.subscription.deleted")).toBe("FREE");
    expect(await prisma.entitlementEvent.findMany({ where: { organizationId: "free" }, orderBy: { createdAt: "asc" }, select: { action: true } })).toEqual([{ action: "STRIPE_PRO_STARTED" }, { action: "STRIPE_PRO_ENDED" }]);
    expect(await prisma.player.count({ where: { groupId: "free-g", isActive: true } })).toBe(40); // nothing deleted
    await signIn("owner");
    expect((await call(playersRoute.POST(json("POST", { firstName: "New", lastName: "P", position: "MIDFIELDER", rating: "GOOD" }), { params: Promise.resolve({ organizationSlug: "free", groupSlug: "free-g" }) }))).body).toMatchObject({ code: "PLAN_LIMIT", error: expect.stringMatching(/Billing page/) });
  });

  it("unpaid → FREE; incomplete never grants PRO; past_due on an invoice event without subscription id is ignored", async () => {
    const a = await subscribe("free", "month", "incomplete");
    await webhook("customer.subscription.created", { id: a.sub.id });
    expect(await plan("free")).toBe("FREE");
    stripe.updateSubscription(a.sub.id, { status: "active" });
    await webhook("invoice.paid", { id: "in_1", parent: { subscription_details: { subscription: a.sub.id } } });
    expect(await plan("free")).toBe("PRO");
    stripe.updateSubscription(a.sub.id, { status: "unpaid" });
    await webhook("customer.subscription.updated", { id: a.sub.id });
    expect(await plan("free")).toBe("FREE");
    expect((await webhook("invoice.paid", { id: "in_2", parent: null })).body).toMatchObject({ ignored: true });
  });

  it("a trial owner subscribes early: PRO now, the trial ends at conversion, trial eligibility untouched; after cancellation: FREE, no new trial", async () => {
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } });
    const { sub } = await subscribe("trial");
    await webhook("customer.subscription.created", { id: sub.id });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: "trial" } });
    expect(org.plan).toBe("PRO");
    expect(org.trialEndsAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u-owner" } })).trialUsedAt).toEqual(userBefore.trialUsedAt);
    stripe.updateSubscription(sub.id, { status: "canceled" });
    await webhook("customer.subscription.deleted", { id: sub.id });
    expect((await planSummary("trial")).plan).toBe("FREE"); // not TRIAL again
    // A User whose trial was used gets no new one on a new Organization either.
    await prisma.user.update({ where: { id: "u-newbie" }, data: { trialUsedAt: new Date() } });
    const ws = await createOrganizationWorkspace("u-newbie", { organizationName: "Newbie FC", groupName: "Mondays", sportKey: "soccer", timezone: "UTC" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: ws.organization.id } })).trialEndsAt).toBeNull();
  });

  it("LEGACY / COMP are never converted by Stripe events (the subscription is recorded with an operator note)", async () => {
    await prisma.organization.update({ where: { id: "legacy" }, data: { stripeCustomerId: "cus_legacy" } });
    stripe.addSubscription({ id: "sub_legacy", customer: "cus_legacy", status: "active", cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: { organizationId: "legacy" }, items: { data: [{ price: { id: PRICES.month }, current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] } });
    await webhook("customer.subscription.created", { id: "sub_legacy" }, { id: "evt_legacy" });
    expect(await plan("legacy")).toBe("LEGACY");
    expect((await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_legacy" } })).error).toMatch(/LEGACY .* not converted automatically/);
    stripe.updateSubscription("sub_legacy", { status: "canceled" });
    await webhook("customer.subscription.deleted", { id: "sub_legacy" });
    expect(await plan("legacy")).toBe("LEGACY");
    expect(await prisma.entitlementEvent.count({ where: { organizationId: "legacy" } })).toBe(0);
  });
});

// ============================================================ PORTAL + RECONCILIATION
describe("M11.2A — Customer Portal and reconciliation", () => {
  it("Portal: OWNER only, for THIS Organization's own Customer, returning to its billing page; none yet → 409", async () => {
    expect(await portal("free")).toMatchObject({ status: 409, body: { code: "NO_CUSTOMER" } });
    await subscribe("free");
    const r = await portal("free");
    expect(r.status).toBe(200);
    const customer = (await prisma.organization.findUniqueOrThrow({ where: { id: "free" } })).stripeCustomerId!;
    expect(stripe.portalCalls).toEqual([{ customer, return_url: "http://itest.local/admin/o/free/billing" }]);
    await signIn("admin");
    expect((await portal("free")).status).toBe(404);
    await signIn("other");
    expect((await portal("free")).status).toBe(404);
    expect(stripe.portalCalls).toHaveLength(1);
  });

  it("reconciliation recovers a missed webhook and is idempotent (no duplicate audit events or subscriptions)", async () => {
    const { sub } = await subscribe("free"); // paid, but no webhook ever arrived
    expect(await plan("free")).toBe("FREE");
    const first = await reconcileBilling();
    expect(first).toMatchObject({ discovered: 1, failures: 0 });
    expect(await plan("free")).toBe("PRO");
    await reconcileBilling();
    await reconcileBilling();
    expect(await prisma.billingSubscription.count()).toBe(1);
    expect(await prisma.entitlementEvent.count({ where: { action: "STRIPE_PRO_STARTED" } })).toBe(1);
    // An abandoned Checkout operation (its URL never reached a browser) is closed.
    await prisma.billingCheckoutSession.create({ data: { organizationId: "other", interval: "month", stripePriceId: PRICES.month, status: "CREATING", expiresAt: new Date(Date.now() + DAY), createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    expect((await reconcileBilling()).checkoutsResolved).toBeGreaterThanOrEqual(1);
    expect(await prisma.billingCheckoutSession.count({ where: { organizationId: "other", status: "FAILED" } })).toBe(1);
    expect(sub.id).toBeTruthy();
  });

  it("reconcile endpoint: CRON_SECRET bearer only (401 / 200)", async () => {
    const req = (auth?: string) => new Request("http://itest.local/api/cron/billing-reconcile", { method: "POST", headers: auth ? { authorization: auth } : {} });
    expect((await call(reconcileRoute.POST(req()))).status).toBe(401);
    expect((await call(reconcileRoute.POST(req("Bearer wrong-secret-value-xx")))).status).toBe(401);
    expect(await call(reconcileRoute.POST(req("Bearer billing-reconcile-test-secret")))).toMatchObject({ status: 200, body: { ok: true } });
    expect(otherNetwork).toBe(0);
  });
});

// ============================================================ M11.3
describe("M11.3 — after the trial ends, only a VERIFIED Stripe subscription restores Telegram", () => {
  it("expired trial → Telegram denied; checkout alone or an unpaid status → still denied; active subscription (webhook-verified) → Pro + Telegram; cancel → Free again; no trial emails to a subscriber", async () => {
    await prisma.organization.update({ where: { id: "free" }, data: { trialStartedAt: new Date(Date.now() - 91 * DAY), trialEndsAt: new Date(Date.now() - DAY) } });
    await expect(assertTelegram("free")).rejects.toThrow(/Pro trial ended on/);

    const { sub } = await subscribe("free", "month", "incomplete");
    await expect(assertTelegram("free")).rejects.toThrow(/Telegram integration is part of Pro/); // the return from Checkout grants nothing
    await webhook("customer.subscription.created", { id: sub.id });
    await expect(assertTelegram("free")).rejects.toThrow(/Telegram integration is part of Pro/); // incomplete = not paid

    stripe.updateSubscription(sub.id, { status: "active" });
    await webhook("customer.subscription.updated", { id: sub.id });
    expect(await plan("free")).toBe("PRO");
    await expect(assertTelegram("free")).resolves.toBeUndefined();

    // A subscriber never gets "your trial ended" email, even inside the expiry-email window.
    testOutbox.clear();
    const run = await runTrialLifecycle(new Date(), { mode: "send" });
    expect(run.emailsSent).toBe(0);
    expect(testOutbox.sent).toEqual([]);

    stripe.updateSubscription(sub.id, { status: "canceled" });
    await webhook("customer.subscription.deleted", { id: sub.id });
    expect(await plan("free")).toBe("FREE");
    await expect(assertTelegram("free")).rejects.toThrow(/Telegram integration is part of Pro/);
    expect((await runTrialLifecycle(new Date(), { mode: "send" })).emailsSent).toBe(0); // converted once → never a trial email again
  });
});

// ============================================================ M11.2B — LIVE MODE
const LIVE_PRICES = { month: "price_live_monthly", year: "price_live_annual" };
/** Every Live condition: Vercel Production + BILLING_ENABLED + BILLING_ALLOW_LIVE_MODE + live key + webhook secret + live Prices. */
function goLive() {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("BILLING_ALLOW_LIVE_MODE", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", FAKE_LIVE_KEY);
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", LIVE_PRICES.month);
  vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", LIVE_PRICES.year);
  stripe = createFakeStripe({ livemode: true });
  setBillingStripeForTests(stripe.api);
  resetPriceCheckCacheForTests();
  resetTaxCheckCacheForTests();
}
const liveWebhook = (type: string, object: Record<string, unknown>, opts: { id?: string } = {}) => webhook(type, object, { livemode: true, id: opts.id ?? `evt_live_${++evtSeq}` });
const reconcileReq = (auth = "Bearer billing-reconcile-test-secret") => new Request("http://itest.local/api/cron/billing-reconcile", { method: "POST", headers: { authorization: auth } });
const liveSub = (id: string, customer: string, organizationId: string, extra: Record<string, unknown> = {}) =>
  stripe.addSubscription({ id, customer, status: "active", cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: { organizationId }, items: { data: [{ price: { id: LIVE_PRICES.month }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400 }] }, ...extra });

describe("M11.2B — Stripe Live mode in Production only", () => {
  it("all conditions met: live Checkout → live webhook → PRO; Portal works; the same flow for the annual Price", async () => {
    goLive();
    expect((await view("free")).body).toMatchObject({ billingEnabled: true, canPurchase: true });
    const r = await checkout("free");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sessionId = String(r.body.url).split("/").pop()!;
    expect(sessionId.startsWith("cs_live_")).toBe(true);
    expect(stripe.calls.retrievePrice).toBe(2); // both Prices verified before any Checkout
    const sub = stripe.completeCheckout(sessionId);
    expect(await liveWebhook("checkout.session.completed", { id: sessionId, subscription: sub.id })).toMatchObject({ status: 200 });
    expect(await plan("free")).toBe("PRO");
    expect(await prisma.billingSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: sub.id } })).toMatchObject({ livemode: true, interval: "month", stripePriceId: LIVE_PRICES.month });
    expect((await portal("free")).status).toBe(200);
    // Annual on another Organization.
    await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: "other", role: "OWNER" } });
    const y = await checkout("other", { interval: "year" });
    expect(y.status).toBe(200);
    expect(stripe.sessions.get(String(y.body.url).split("/").pop()!)!.price).toBe(LIVE_PRICES.year);
    expect(otherNetwork).toBe(0);
  });

  it("disabled — no Stripe call at all — when ANY flag or credential is missing", async () => {
    const cases: Array<[string, string]> = [
      ["BILLING_ENABLED", ""],
      ["BILLING_ALLOW_LIVE_MODE", ""],
      ["BILLING_ALLOW_LIVE_MODE", "false"],
      ["VERCEL_ENV", "preview"],
      ["VERCEL_ENV", "development"],
      ["VERCEL_ENV", ""],
      ["STRIPE_SECRET_KEY", ""],
      ["STRIPE_SECRET_KEY", "sk_live_x"],
      ["STRIPE_SECRET_KEY", "sk_test_m112a_fake_key"], // test key in Production
      ["STRIPE_WEBHOOK_SECRET", ""],
      ["STRIPE_PRICE_PRO_MONTHLY", ""],
      ["STRIPE_PRICE_PRO_ANNUAL", ""],
      ["BILLING_TERMS", "pending"], // the paid-subscription terms are not published yet
    ];
    for (const [name, value] of cases) {
      goLive();
      if (name === "BILLING_TERMS") legal.items = [PENDING_BILLING_TERMS];
      else vi.stubEnv(name, value);
      const label = `${name}=${value}`;
      expect(await checkout("free"), label).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
      expect((await portal("free")).status, label).toBe(503);
      expect((await liveWebhook("customer.subscription.updated", { id: "sub_x" })).status, label).toBe(503);
      expect((await call(reconcileRoute.POST(reconcileReq()))).status, label).toBe(503);
      expect((await view("free")).body.billingEnabled, label).toBe(false);
      expect(Object.keys(stripe.calls), label).toEqual([]);
      legal.items = [];
    }
    expect(await prisma.billingCheckoutSession.count()).toBe(0);
  });

  it("Prices are verified against Stripe before Checkout: test-mode, inactive, one-time, wrong interval / amount / currency / product, or missing → no Checkout", async () => {
    const bad: Array<[string, Record<string, unknown> | null]> = [
      [LIVE_PRICES.month, { livemode: false }], // a TEST Price id configured in live
      [LIVE_PRICES.year, { livemode: false }],
      [LIVE_PRICES.month, { active: false }],
      [LIVE_PRICES.month, { type: "one_time", recurring: null }],
      [LIVE_PRICES.month, { recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } }],
      [LIVE_PRICES.month, { recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } }],
      [LIVE_PRICES.month, { recurring: { interval: "month", interval_count: 1, usage_type: "metered" } }],
      [LIVE_PRICES.month, { unit_amount: 899 }],
      [LIVE_PRICES.year, { unit_amount: 9999 }],
      [LIVE_PRICES.month, { currency: "eur" }],
      [LIVE_PRICES.year, { product: "prod_other" }],
      [LIVE_PRICES.month, null], // "No such price" (e.g. a test id looked up with the live key)
    ];
    for (const [priceId, patch] of bad) {
      goLive();
      stripe.prices.set(priceId, patch);
      const label = `${priceId} ${JSON.stringify(patch)}`;
      expect(await checkout("free"), label).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
      expect(stripe.calls.createCustomer ?? 0, label).toBe(0);
      expect(stripe.calls.createCheckoutSession ?? 0, label).toBe(0);
    }
    expect(await prisma.billingCheckoutSession.count({ where: { status: { not: "FAILED" } } })).toBe(0); // refused before Stripe: closed
    // Stripe unreachable while verifying → fail closed; the next attempt (Stripe back) works.
    goLive();
    stripe.failNext.retrievePrice = "outage";
    expect((await checkout("free")).status).toBe(503);
    expect((await checkout("free")).status).toBe(200);
  });

  it("customer isolation: a stored TEST-mode Customer is never used live — Checkout makes a live one; Portal refuses the test one", async () => {
    // Made in test mode (e.g. a Preview database later copied): the id does not exist for the live key.
    await prisma.organization.update({ where: { id: "free" }, data: { stripeCustomerId: "cus_test_from_preview" } });
    goLive();
    expect(await portal("free")).toMatchObject({ status: 409, body: { code: "NO_CUSTOMER" } });
    expect(stripe.portalCalls).toHaveLength(0);
    const r = await checkout("free");
    expect(r.status).toBe(200);
    const stored = (await prisma.organization.findUniqueOrThrow({ where: { id: "free" } })).stripeCustomerId!;
    expect(stored).not.toBe("cus_test_from_preview");
    expect(stripe.customers.has(stored)).toBe(true);
    expect(stripe.sessions.get(String(r.body.url).split("/").pop()!)!.customer).toBe(stored);
    // A Stripe outage while checking the stored Customer never replaces it.
    await prisma.organization.update({ where: { id: "other" }, data: { stripeCustomerId: "cus_keep" } });
    stripe.customers.set("cus_keep", { id: "cus_keep", name: "Org other", metadata: { organizationId: "other" } });
    await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: "other", role: "OWNER" } });
    stripe.failNext.retrieveCustomer = "outage";
    expect((await checkout("other")).status).toBe(503);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: "other" } })).stripeCustomerId).toBe("cus_keep");
    expect((await checkout("other")).status).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: "other" } })).stripeCustomerId).toBe("cus_keep");
  });

  it("subscription / event isolation: TEST data never counts or syncs live; a test-mode subscription or event is refused", async () => {
    // A stored test-mode paid subscription (copied from Preview): no Pro, no ownership unlock, not reconciled.
    await prisma.organization.update({ where: { id: "free" }, data: { stripeCustomerId: "cus_t", plan: "PRO" } });
    await prisma.billingSubscription.create({ data: { organizationId: "free", stripeSubscriptionId: "sub_test_old", stripeCustomerId: "cus_t", status: "active", livemode: false, lastSyncedAt: new Date() } });
    await prisma.stripeEvent.create({ data: { id: "evt_test_stuck", type: "customer.subscription.updated", livemode: false, status: "FAILED", objectId: "sub_test_old" } });
    goLive();
    await prisma.organizationMembership.deleteMany({ where: { userId: "u-owner", organizationId: { in: ["legacy", "comp"] } } });
    expect(await ownershipAllowance("u-owner")).toMatchObject({ qualifiedBy: null });
    const r = await call(reconcileRoute.POST(reconcileReq()));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(stripe.calls.retrieveSubscription ?? 0).toBe(0); // the test rows were never sent to the live key
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "evt_test_stuck" } })).toMatchObject({ status: "FAILED" });
    // Test-mode webhook event in live → 400, nothing stored.
    expect((await webhook("customer.subscription.updated", { id: "sub_x" }, { livemode: false })).status).toBe(400);
    expect(await prisma.stripeEvent.count({ where: { livemode: true } })).toBe(0);
    // A live-key response claiming test mode is an operator exception, never applied.
    await prisma.organization.update({ where: { id: "other" }, data: { stripeCustomerId: "cus_live_other" } });
    liveSub("sub_mode_mismatch", "cus_live_other", "other", { livemode: false });
    expect((await liveWebhook("customer.subscription.created", { id: "sub_mode_mismatch" })).body).toMatchObject({ exception: true });
    expect(await plan("other")).toBe("FREE");
  });

  it("reconciliation in live: auth, idempotency, mode-correct exception records, failures visible without personal data", async () => {
    goLive();
    expect((await call(reconcileRoute.POST(reconcileReq("Bearer wrong-secret-value-xx")))).status).toBe(401);
    expect((await call(reconcileRoute.POST(new Request("http://itest.local/", { method: "POST" })))).status).toBe(401);
    // A paid live subscription whose webhook was missed is recovered once.
    await prisma.organization.update({ where: { id: "free" }, data: { stripeCustomerId: "cus_live_free" } });
    stripe.customers.set("cus_live_free", { id: "cus_live_free", name: "Org free", metadata: { organizationId: "free" } });
    liveSub("sub_live_missed", "cus_live_free", "free");
    // An inconsistent one (wrong Organization metadata) → a synthetic exception, recorded as LIVE.
    liveSub("sub_live_bad", "cus_live_free", "other");
    const first = await call(reconcileRoute.POST(reconcileReq()));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, discovered: 2, synced: 1, failures: 0, exceptions: 1 });
    expect(await plan("free")).toBe("PRO");
    expect(await prisma.stripeEvent.findUniqueOrThrow({ where: { id: "reconcile:sub_live_bad" } })).toMatchObject({ livemode: true, status: "EXCEPTION" });
    for (let i = 0; i < 2; i++) expect((await call(reconcileRoute.POST(reconcileReq()))).status).toBe(200);
    expect(await prisma.billingSubscription.count()).toBe(1);
    expect(await prisma.entitlementEvent.count({ where: { action: "STRIPE_PRO_STARTED" } })).toBe(1);
    // A Stripe outage → 500 ok:false with counts only (no ids, emails, names or secrets in the body).
    stripe.failNext.retrieveSubscription = "outage";
    const failed = await call(reconcileRoute.POST(reconcileReq()));
    expect(failed.status).toBe(500);
    expect(failed.body.ok).toBe(false);
    expect(Object.keys(failed.body).sort()).toEqual(["checkoutsResolved", "discovered", "eventsRecovered", "exceptions", "failures", "ok", "synced"]);
    expect(JSON.stringify(failed.body)).not.toMatch(/cus_|sub_|@|sk_|whsec_|Org /);
    expect(await plan("free")).toBe("PRO"); // a failed run changes nothing
  });

  it("trial and Pro entitlements are unchanged by live mode", async () => {
    goLive();
    expect(await organizationPlan("trial")).toMatchObject({ plan: "TRIAL", limits: PLAN_LIMITS.TRIAL });
    expect(await organizationPlan("free")).toMatchObject({ plan: "FREE", limits: PLAN_LIMITS.FREE });
    expect((await planSummary("trial")).telegram).toBe(true);
    const r = await checkout("trial");
    expect(r.status).toBe(200);
    const sub = stripe.completeCheckout(String(r.body.url).split("/").pop()!);
    await liveWebhook("customer.subscription.created", { id: sub.id });
    expect(await organizationPlan("trial")).toMatchObject({ plan: "PRO", limits: PLAN_LIMITS.PRO });
    await assertTelegram("trial");
    stripe.updateSubscription(sub.id, { status: "canceled", ended_at: Math.floor(Date.now() / 1000) });
    await liveWebhook("customer.subscription.deleted", { id: sub.id });
    expect((await planSummary("trial")).plan).toBe("FREE"); // no second trial
    expect((await planSummary("comp")).plan).toBe("COMP");
    expect((await planSummary("legacy")).plan).toBe("LEGACY");
  });
});

// ============================================================ M11.2B — SCHEDULED CANCELLATION
describe("M11.2B — scheduled cancellation (Customer Portal cancel_at and cancel_at_period_end)", () => {
  const subView = async (org = "free") => (await view(org)).body.subscription as Record<string, unknown>;
  const periodEndOf = (subId: string) => stripe.subs.get(subId)!.items.data[0].current_period_end;

  it("Portal cancellation (cancel_at set, cancel_at_period_end=false): Pro kept, access-end date shown; ends → Free", async () => {
    const { sub } = await subscribe("free", "month");
    await webhook("customer.subscription.created", { id: sub.id });
    expect((await subView()).accessEndsAt).toBeNull(); // renewing
    const end = periodEndOf(sub.id);
    // Exactly what the Sandbox Portal sent: cancel_at = period end, cancel_at_period_end stays false.
    stripe.updateSubscription(sub.id, { cancel_at: end, cancel_at_period_end: false, canceled_at: Math.floor(Date.now() / 1000) });
    expect((await webhook("customer.subscription.updated", { id: sub.id })).status).toBe(200);
    expect(await plan("free")).toBe("PRO"); // access kept until it actually ends
    await assertTelegram("free");
    expect(await prisma.billingSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: sub.id } })).toMatchObject({ status: "active", cancelAtPeriodEnd: false, cancelAt: new Date(end * 1000) });
    expect(await subView()).toMatchObject({ status: "active", interval: "month", cancelAtPeriodEnd: false, accessEndsAt: new Date(end * 1000).toISOString() });
    // Stripe ends it at cancel_at.
    stripe.updateSubscription(sub.id, { status: "canceled", ended_at: end });
    await webhook("customer.subscription.deleted", { id: sub.id });
    expect(await plan("free")).toBe("FREE");
    expect(await subView()).toMatchObject({ status: "canceled", accessEndsAt: null });
  });

  it("traditional cancel_at_period_end=true on an annual plan: Pro kept, ends at the period end; resuming clears it", async () => {
    const { sub } = await subscribe("free", "year");
    await webhook("customer.subscription.created", { id: sub.id });
    stripe.updateSubscription(sub.id, { cancel_at_period_end: true });
    await webhook("customer.subscription.updated", { id: sub.id });
    expect(await plan("free")).toBe("PRO");
    expect(await subView()).toMatchObject({ interval: "year", cancelAtPeriodEnd: true, accessEndsAt: new Date(periodEndOf(sub.id) * 1000).toISOString() });
    // Resumed in the Portal before the end: renewing again.
    stripe.updateSubscription(sub.id, { cancel_at_period_end: false, cancel_at: null, canceled_at: null });
    await webhook("customer.subscription.updated", { id: sub.id });
    expect(await subView()).toMatchObject({ cancelAtPeriodEnd: false, accessEndsAt: null });
    expect((await prisma.billingSubscription.findUniqueOrThrow({ where: { stripeSubscriptionId: sub.id } })).cancelAt).toBeNull();
    expect(await plan("free")).toBe("PRO");
  });

  it("a cancel_at different from the period end: the actual cancel_at date is shown", async () => {
    const { sub } = await subscribe("free", "month");
    const later = periodEndOf(sub.id) + 40 * 86_400;
    stripe.updateSubscription(sub.id, { cancel_at: later });
    await webhook("customer.subscription.updated", { id: sub.id });
    expect(await subView()).toMatchObject({ accessEndsAt: new Date(later * 1000).toISOString(), currentPeriodEnd: new Date(periodEndOf(sub.id) * 1000).toISOString() });
    expect(await plan("free")).toBe("PRO");
  });

  it("reconciliation also picks up a scheduled cancellation whose webhook was missed", async () => {
    const { sub } = await subscribe("free", "month");
    await webhook("customer.subscription.created", { id: sub.id });
    stripe.updateSubscription(sub.id, { cancel_at: periodEndOf(sub.id) }); // no webhook delivered
    expect((await subView()).accessEndsAt).toBeNull();
    await reconcileBilling();
    expect((await subView()).accessEndsAt).toBe(new Date(periodEndOf(sub.id) * 1000).toISOString());
    expect(await plan("free")).toBe("PRO");
  });
});

// ============================================================ M11.2C — LAUNCH SAFEGUARDS
describe("M11.2C — Terms agreement, US-only address and tax readiness before Checkout", () => {
  const ops = () => prisma.billingCheckoutSession.findMany({ orderBy: { createdAt: "asc" } });

  it("no Terms agreement, a non-US country, a non-US state or a bad ZIP → 400 before any Stripe call", async () => {
    expect(await checkout("free", { interval: "month", acceptTerms: false })).toMatchObject({ status: 400, body: { code: "TERMS_REQUIRED" } });
    expect(await checkout("free", { interval: "month", acceptTerms: "yes" })).toMatchObject({ status: 400, body: { code: "TERMS_REQUIRED" } });
    for (const country of ["CA", "GB", "PR"]) expect(await checkout("free", { interval: "month", address: { ...US_ADDRESS, country } }), country).toMatchObject({ status: 400, body: { code: "US_ONLY", field: "country" } });
    expect(await checkout("free", { interval: "month", address: { ...US_ADDRESS, state: "ON" } })).toMatchObject({ status: 400, body: { code: "ADDRESS_INVALID", field: "state" } });
    expect(await checkout("free", { interval: "month", address: { ...US_ADDRESS, postal_code: "K1A 0B1" } })).toMatchObject({ status: 400, body: { code: "ADDRESS_INVALID", field: "postal_code" } });
    expect(await checkout("free", { interval: "month", address: null })).toMatchObject({ status: 400 });
    expect(Object.keys(stripe.calls)).toEqual([]);
    expect(await ops()).toEqual([]);
  });

  it("a US address: stored on the Stripe Customer (tax-validated); Checkout uses automatic tax and can't change the address; Terms version recorded", async () => {
    const r = await checkout("free", { interval: "month" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = [...stripe.sessions.values()][0];
    expect(s.params).toMatchObject({ automatic_tax: { enabled: true }, customer_update: { address: "never" }, billing_address_collection: "auto", subscription_data: { metadata: { organizationId: "free", termsVersion: expect.any(String) } } });
    expect(s.params.metadata).toMatchObject({ organizationId: "free", termsVersion: expect.any(String), termsAcceptedBy: "u-owner", termsAcceptedAt: expect.any(String) });
    const customerId = (await prisma.organization.findUniqueOrThrow({ where: { id: "free" } })).stripeCustomerId!;
    expect(stripe.customers.get(customerId)!.address).toMatchObject({ country: "US", state: "MA", postal_code: "02108" });
    const [op] = await ops();
    expect(op.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(op)).not.toMatch(/Main St|Boston|02108/); // no address in our database
  });

  it("Stripe Tax not ready → no Checkout: inactive, lookup outage, inclusive / unresolved tax behavior", async () => {
    const refused = async (label: string, setup: () => void) => {
      stripe = createFakeStripe();
      setBillingStripeForTests(stripe.api);
      resetTaxCheckCacheForTests();
      resetPriceCheckCacheForTests();
      setup();
      expect(await checkout("free"), label).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
      expect(stripe.calls.createCustomer ?? 0, label).toBe(0);
      expect(stripe.calls.updateCustomerAddress ?? 0, label).toBe(0);
      expect(stripe.calls.createCheckoutSession ?? 0, label).toBe(0);
    };
    await refused("pending", () => (stripe.tax.settings = { status: "pending", defaultTaxBehavior: "exclusive" }));
    await refused("outage", () => (stripe.failNext.retrieveTaxSettings = "outage"));
    await refused("inclusive price", () => stripe.prices.set(PRICES.month, { tax_behavior: "inclusive" }));
    await refused("unspecified + inclusive default", () => {
      stripe.prices.set(PRICES.year, { tax_behavior: "unspecified" });
      stripe.tax.settings = { status: "active", defaultTaxBehavior: "inclusive" };
    });
    expect(await prisma.billingCheckoutSession.count({ where: { status: { not: "FAILED" } } })).toBe(0);
    // Unspecified Prices with the USD default (inferred by currency → exclusive) are fine.
    stripe = createFakeStripe();
    setBillingStripeForTests(stripe.api);
    resetTaxCheckCacheForTests();
    resetPriceCheckCacheForTests();
    stripe.prices.set(PRICES.month, { tax_behavior: "unspecified" });
    stripe.tax.settings = { status: "active", defaultTaxBehavior: "inferred_by_currency" };
    expect((await checkout("free")).status).toBe(200);
  });

  it("M11.2G: tax collection locations are not an app requirement — none, or another state only, both proceed with automatic tax; no registration lookup", async () => {
    for (const live of [false, true]) {
      for (const [label, registrations] of [
        ["no collection locations", []],
        ["another state only", [{ country: "US", state: "NY" }]],
      ] as const) {
        if (live) goLive(); // a fresh live fake each case
        else {
          stripe = createFakeStripe();
          setBillingStripeForTests(stripe.api);
          resetTaxCheckCacheForTests();
          resetPriceCheckCacheForTests();
        }
        await prisma.billingCheckoutSession.deleteMany({});
        stripe.tax.registrations = [...registrations];
        const r = await checkout("free");
        expect(r.status, `${label} live=${live} ${JSON.stringify(r.body)}`).toBe(200);
        const s = [...stripe.sessions.values()][0];
        expect(s.params.automatic_tax, label).toEqual({ enabled: true });
        expect(s.params.customer_update, label).toEqual({ address: "never" });
        expect(Object.keys(stripe.calls).some((k) => /regist/i.test(k)), label).toBe(false); // never looked up
        expect(stripe.calls.retrieveTaxSettings, label).toBe(1); // Stripe Tax must still be active
      }
    }
  });

  it("every subscription Checkout (monthly and annual, test and live) uses automatic tax", async () => {
    for (const live of [false, true]) {
      if (live) goLive();
      await prisma.billingCheckoutSession.deleteMany({});
      for (const [org, interval] of [["free", "month"], ["trial", "year"]] as const) {
        expect((await checkout(org, { interval })).status, `${org} ${interval} live=${live}`).toBe(200);
      }
      const sessions = [...stripe.sessions.values()];
      expect(sessions).toHaveLength(2);
      for (const s of sessions) {
        expect(s.params.automatic_tax).toEqual({ enabled: true });
        expect(s.params).not.toHaveProperty("subscription_data.default_tax_rates");
        expect(s.params.line_items).toEqual([{ price: s.price, quantity: 1 }]);
      }
      expect(sessions.map((s) => s.price).sort()).toEqual(live ? [LIVE_PRICES.year, LIVE_PRICES.month].sort() : [PRICES.year, PRICES.month].sort());
    }
  });

  it("an address Stripe Tax can't place → 400 with a clear message; the operation is closed; no session", async () => {
    stripe.tax.invalidPostalCodes.add("02108");
    expect(await checkout("free")).toMatchObject({ status: 400, body: { code: "ADDRESS_INVALID", error: expect.stringMatching(/couldn't verify this billing address for sales tax/) } });
    expect(stripe.calls.createCheckoutSession ?? 0).toBe(0);
    expect((await ops()).map((o) => o.status)).toEqual(["FAILED"]);
    stripe.tax.invalidPostalCodes.clear();
    expect((await checkout("free")).status).toBe(200); // corrected → works
  });

  it("same address → the same session; a changed address → the old session is expired first and a new one created", async () => {
    const a = await checkout("free");
    const b = await checkout("free");
    expect(b.body.url).toBe(a.body.url);
    expect(stripe.sessions.size).toBe(1);
    const c = await checkout("free", { interval: "month", address: { ...US_ADDRESS, postal_code: "02109" } });
    expect(c.status).toBe(200);
    expect(c.body.url).not.toBe(a.body.url);
    expect([...stripe.sessions.values()].map((s) => s.status)).toEqual(["expired", "open"]);
    expect((await ops()).map((o) => o.status)).toEqual(["EXPIRED", "OPEN"]);
  });

  it("Live (Production) Checkout uses the same tax and address rules", async () => {
    goLive();
    expect((await checkout("free", { interval: "month", address: { ...US_ADDRESS, country: "CA" } })).status).toBe(400);
    const r = await checkout("free");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([...stripe.sessions.values()][0].params).toMatchObject({ automatic_tax: { enabled: true }, customer_update: { address: "never" } });
    goLive();
    stripe.tax.settings = { status: "pending", defaultTaxBehavior: "exclusive" }; // Stripe Tax not active in Live
    expect((await checkout("other")).status).toBe(404); // not an owner of "other"
    await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: "other", role: "OWNER" } });
    expect(await checkout("other")).toMatchObject({ status: 503, body: { code: "BILLING_UNAVAILABLE" } });
  });

  it("only the OWNER can start Checkout, even with a valid address and agreement (ADMIN / MEMBER / other tenant → 404)", async () => {
    for (const who of ["admin", "member", "other"]) {
      await signIn(who);
      expect((await checkout("free")).status, who).toBe(404);
    }
    expect(Object.keys(stripe.calls)).toEqual([]);
  });
});

describe("M11.2C — an organization with an unfinished subscription can't be deleted or lose its last owner", () => {
  const guard = /TBP_BILLING_GUARD/;
  async function activeSub(org = "free") {
    const { sub } = await subscribe(org);
    await webhook("customer.subscription.created", { id: sub.id });
    return sub;
  }

  it("deleting the organization is refused while the subscription is active or scheduled to end; allowed once it has ended", async () => {
    const sub = await activeSub();
    await expect(prisma.organization.delete({ where: { id: "free" } })).rejects.toThrow(guard);
    stripe.updateSubscription(sub.id, { cancel_at: sub.items.data[0].current_period_end }); // Portal cancellation (still active)
    await webhook("customer.subscription.updated", { id: sub.id });
    await expect(prisma.organization.delete({ where: { id: "free" } })).rejects.toThrow(guard);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = 'free'`)).rejects.toThrow(guard); // raw SQL too
    stripe.updateSubscription(sub.id, { status: "canceled", ended_at: Math.floor(Date.now() / 1000) });
    await webhook("customer.subscription.deleted", { id: sub.id });
    await prisma.organization.delete({ where: { id: "free" } });
    expect(await prisma.organization.findUnique({ where: { id: "free" } })).toBeNull();
  });

  it("the last owner can't be removed, demoted, moved or deleted (User cascade) while it's unfinished; a second owner makes it possible", async () => {
    await activeSub();
    const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId: "free", userId: "u-owner" } });
    await expect(prisma.organizationMembership.delete({ where: { id: ownerMembership.id } })).rejects.toThrow(guard);
    await expect(prisma.organizationMembership.update({ where: { id: ownerMembership.id }, data: { role: "ADMIN" } })).rejects.toThrow(guard);
    await expect(prisma.organizationMembership.update({ where: { id: ownerMembership.id }, data: { organizationId: "other" } })).rejects.toThrow(guard);
    await expect(prisma.user.delete({ where: { id: "u-owner" } })).rejects.toThrow(guard);
    expect(await prisma.user.findUnique({ where: { id: "u-owner" } })).not.toBeNull();
    // Other members are unaffected.
    await prisma.organizationMembership.deleteMany({ where: { organizationId: "free", userId: "u-member" } });
    // Promote the admin to a second owner → the first owner can now leave.
    await prisma.organizationMembership.updateMany({ where: { organizationId: "free", userId: "u-admin" }, data: { role: "OWNER" } });
    await prisma.organizationMembership.delete({ where: { id: ownerMembership.id } });
    expect(await prisma.organizationMembership.count({ where: { organizationId: "free", role: "OWNER" } })).toBe(1);
  });

  it("tenant isolation: another organization's subscription never blocks deleting an organization without one", async () => {
    await activeSub("free");
    await prisma.organization.delete({ where: { id: "other" } }); // no subscription of its own
    await prisma.user.delete({ where: { id: "u-other" } }).catch(() => undefined);
    expect(await prisma.organization.findUnique({ where: { id: "other" } })).toBeNull();
    await expect(prisma.organization.delete({ where: { id: "free" } })).rejects.toThrow(guard);
  });
});

describe("M11.2C — webhook and return diagnostics (non-sensitive)", () => {
  it("each applied webhook logs event id, type and outcome only; a mismatched return logs a reason code only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { sessionId, sub } = await subscribe("free");
      await webhook("customer.subscription.updated", { id: sub.id }, { id: "evt_diag_1" });
      const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("evt_diag_1"));
      expect(line).toBe("[billing] webhook evt_diag_1 (customer.subscription.updated) processed: plan PRO (changed)");
      // Another tenant's owner opens this organization's session id on their own billing page.
      await prisma.organizationMembership.create({ data: { userId: "u-owner", organizationId: "other", role: "OWNER" } });
      expect(await confirmCheckoutReturn(await requireOrganizationContextForSlug({ organizationSlug: "other" }), sessionId)).toBe("ignored");
      expect(await confirmCheckoutReturn(await requireOrganizationContextForSlug({ organizationSlug: "free" }), "sub_not_a_session")).toBe("ignored");
      const logged = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("checkout return ignored"));
      expect(logged).toEqual(["[billing] checkout return ignored: organization_mismatch", "[billing] checkout return ignored: session_id_format"]);
      expect(logged.join(" ")).not.toMatch(/cs_|sub_|cus_|@/);
    } finally {
      info.mockRestore();
    }
  });
});
