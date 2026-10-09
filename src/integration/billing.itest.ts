/**
 * M11.2A — Stripe billing (TEST MODE), REAL DATABASE (guarded local test DB
 * only) with a FAKE Stripe adapter: no network call of any kind is made
 * (global fetch is a tripwire). Webhook signatures use the real Stripe SDK's
 * offline signing helpers with a test secret.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

type TestSession = { user: { id?: string; email: string } } | null;
let session: TestSession = null;
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/prisma";
import * as billingRoute from "@/app/api/admin/o/[organizationSlug]/billing/route";
import * as checkoutRoute from "@/app/api/admin/o/[organizationSlug]/billing/checkout/route";
import * as portalRoute from "@/app/api/admin/o/[organizationSlug]/billing/portal/route";
import * as webhookRoute from "@/app/api/stripe/webhook/route";
import * as reconcileRoute from "@/app/api/cron/billing-reconcile/route";
import * as playersRoute from "@/app/api/admin/o/[organizationSlug]/g/[groupSlug]/players/route";
import { setBillingStripeForTests, generateTestSignature } from "@/lib/billing/stripe";
import { confirmCheckoutReturn } from "@/lib/billing/checkout";
import { reconcileBilling } from "@/lib/billing/sync";
import { planSummary } from "@/lib/entitlements";
import { requireOrganizationContextForSlug } from "@/lib/tenantContext";
import { createOrganizationWorkspace } from "@/lib/workspaces";
import { createFakeStripe, type FakeStripe } from "./fakeStripe";

const WHSEC = "whsec_test_m112a_integration_secret";
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
const checkout = (org: string, body: unknown = { interval: "month" }) => call(checkoutRoute.POST(json("POST", body), o(org)));
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
  stripe = createFakeStripe();
  setBillingStripeForTests(stripe.api);
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

  it("a LIVE key is rejected even with BILLING_ALLOW_LIVE_MODE=true", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_should_never_be_used");
    vi.stubEnv("BILLING_ALLOW_LIVE_MODE", "true");
    expect((await checkout("free")).status).toBe(503);
    expect((await view("free")).body.billingEnabled).toBe(false);
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
    expect(String((s.params.custom_text as { submit: { message: string } }).submit.message)).toMatch(/billing starts today/i);
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
