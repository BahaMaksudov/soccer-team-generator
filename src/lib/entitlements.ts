import { NextResponse } from "next/server";
import type { OrganizationPlan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { billingConfig, stripeModePermitted } from "@/lib/billing/config";

/**
 * M11.1 — plans, the introductory trial and entitlements: the ONE place that
 * decides what an Organization may do. Server-authoritative; scoped to the
 * Organization (never a User, Group or Community).
 *
 * Effective plan:
 *   COMP    → complimentary Pro (explicitly granted, audited);
 *   PRO     → paid Pro (future Stripe integration);
 *   LEGACY  → grandfathered pre-M11 Organization: no limits (current capabilities kept);
 *   FREE + trialEndsAt in the future → TRIAL (Pro limits);
 *   FREE    → Free.
 *
 * Capacity checks run INSIDE the caller's transaction after a per-Organization
 * advisory lock, so concurrent requests cannot both pass a limit. Limits only
 * block capacity-increasing actions: nothing is ever hidden, deleted or
 * deactivated because of a plan.
 */

export const TRIAL_DAYS = 90;
export const AI_RESERVATION_TTL_MS = 2 * 60_000; // the AI call itself times out after 15 s

export type EffectivePlan = "FREE" | "TRIAL" | "PRO" | "COMP" | "LEGACY";
export type Limits = {
  activeGroups: number | null;
  activePlayers: number | null;
  monthlyMatches: number | null;
  activeSchedules: number | null;
  monthlyAiRecaps: number | null;
  telegram: boolean;
};
export type CapacityMetric = "activeGroups" | "activePlayers" | "monthlyMatches" | "activeSchedules";

const FREE: Limits = { activeGroups: 1, activePlayers: 30, monthlyMatches: 8, activeSchedules: 1, monthlyAiRecaps: 2, telegram: false };
const PRO: Limits = { activeGroups: 3, activePlayers: 150, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: 30, telegram: true };
const UNLIMITED: Limits = { activeGroups: null, activePlayers: null, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: null, telegram: true };

export const PLAN_LIMITS: Record<EffectivePlan, Limits> = { FREE, TRIAL: PRO, PRO, COMP: PRO, LEGACY: UNLIMITED };
export const PLAN_LABEL: Record<EffectivePlan, string> = { FREE: "Free", TRIAL: "Pro trial", PRO: "Pro", COMP: "Pro (complimentary)", LEGACY: "Early access" };

export function effectivePlan(org: { plan: OrganizationPlan; trialEndsAt: Date | null }, now: Date = new Date()): EffectivePlan {
  if (org.plan !== "FREE") return org.plan;
  return org.trialEndsAt && org.trialEndsAt.getTime() > now.getTime() ? "TRIAL" : "FREE";
}

/** UTC calendar month: "YYYY-MM", its start, and the next reset. */
export function utcMonth(now: Date = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { period: start.toISOString().slice(0, 7), start, next };
}

export function trialDaysLeft(trialEndsAt: Date | null, now: Date = new Date()): number | null {
  if (!trialEndsAt || trialEndsAt.getTime() <= now.getTime()) return null;
  return Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000);
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function organizationPlan(organizationId: string, now: Date = new Date(), db: Db = prisma) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, trialEndsAt: true } });
  const plan = effectivePlan(org, now);
  return { plan, limits: PLAN_LIMITS[plan], trialEndsAt: org.trialEndsAt };
}

/** Current usage of every metered capacity (unique active Players: one Player row = one person; Community memberships don't add). */
export async function capacityUsage(organizationId: string, now: Date = new Date(), db: Db = prisma): Promise<Record<CapacityMetric, number>> {
  const { start } = utcMonth(now);
  const [activeGroups, activePlayers, monthlyMatches, activeSchedules] = await Promise.all([
    db.group.count({ where: { organizationId, isActive: true } }),
    db.player.count({ where: { isActive: true, group: { organizationId } } }),
    db.match.count({ where: { createdAt: { gte: start }, group: { organizationId } } }),
    db.matchSchedule.count({ where: { isActive: true, group: { organizationId } } }),
  ]);
  return { activeGroups, activePlayers, monthlyMatches, activeSchedules };
}

/** AI credits used this UTC month: successful generations + reservations still in flight. */
export async function aiCreditsUsed(organizationId: string, now: Date = new Date(), db: Db = prisma): Promise<number> {
  const { period } = utcMonth(now);
  return db.aiUsage.count({ where: { organizationId, period, OR: [{ status: "SUCCEEDED" }, { status: "RESERVED", expiresAt: { gt: now } }] } });
}

const NOUN: Record<CapacityMetric, (n: number) => string> = {
  activeGroups: (n) => `${n} active group${n === 1 ? "" : "s"}`,
  activePlayers: (n) => `${n} active players`,
  monthlyMatches: (n) => `${n} new matches per month`,
  activeSchedules: (n) => `${n} active recurring schedule${n === 1 ? "" : "s"}`,
};

/** Until Stripe billing exists there is no upgrade action: Free limits say so instead of offering one. */
export const FREE_LIMIT_COMING_SOON = "Pro plans and upgrades are coming soon.";
export const FREE_LIMIT_UPGRADE = "Upgrade to Pro on your organization's Billing page.";

/** "Your Free plan limit has been reached (30 active players). Pro plans and upgrades are coming soon." */
export function limitReachedMessage(plan: EffectivePlan, detail: string): string {
  if (plan !== "FREE") return `Your ${PLAN_LABEL[plan]} plan limit has been reached (${detail}).`;
  // M11.2A — once billing is enabled (test mode), point owners to the Billing page instead of "coming soon".
  return `Your Free plan limit has been reached (${detail}). ${billingConfig().enabled ? FREE_LIMIT_UPGRADE : FREE_LIMIT_COMING_SOON}`;
}

export class EntitlementError extends Error {
  readonly metric: CapacityMetric | "telegram" | "monthlyAiRecaps";
  readonly limit: number | null;
  constructor(metric: EntitlementError["metric"], limit: number | null, message: string) {
    super(message);
    this.name = "EntitlementError";
    this.metric = metric;
    this.limit = limit;
  }
}

/** HTTP shape of a plan limit (402 + code PLAN_LIMIT), shared by every enforcement point. */
export function planLimitResponse(e: EntitlementError): NextResponse {
  return NextResponse.json({ error: e.message, code: "PLAN_LIMIT", metric: e.metric, limit: e.limit }, { status: 402 });
}

/** Serialize capacity-changing work of one Organization (transaction-scoped). */
async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"entitlement:" + organizationId}))`;
}

/**
 * Inside the caller's transaction: lock the Organization and throw
 * EntitlementError if one more `metric` would exceed the plan (`adding`
 * units; the caller then performs the write in the same transaction).
 */
export async function assertCapacity(tx: Prisma.TransactionClient, organizationId: string, metric: CapacityMetric, now: Date = new Date(), adding = 1): Promise<void> {
  await lockOrganization(tx, organizationId);
  const { plan, limits } = await organizationPlan(organizationId, now, tx);
  const limit = limits[metric];
  if (limit === null) return;
  const used = (await capacityUsage(organizationId, now, tx))[metric];
  if (used + adding > limit) {
    throw new EntitlementError(metric, limit, limitReachedMessage(plan, NOUN[metric](limit)));
  }
}

/**
 * Phase 1 — Organization ownership allowance (per User; plans stay per Organization).
 *
 * A User may own 1 Organization; 2 while at least one Organization they own
 * qualifies; never more. Qualifying: paid Pro, complimentary Pro (COMP) or
 * Legacy / Early Access. Free and the introductory trial never qualify.
 * "Paid Pro" = Organization.plan PRO AND a Stripe subscription of that
 * Organization in a PAID status: the entitling statuses minus "trialing" (a
 * Stripe trial is not a payment), keeping the past_due payment grace. A raw
 * PRO value without such a subscription does not qualify, and neither does a
 * subscription in a Stripe mode this deployment does not permit (test mode in
 * Vercel Production; live mode until it is launched) or one whose Customer is
 * not the Organization's own (stripeModePermitted / paidSubscriptionQualifies).
 *
 * Limits only gate CREATION: an owner above the allowance (existing data, or
 * Pro ended later) keeps every Organization they own. Being an ADMIN/MEMBER
 * of other Organizations never uses the allowance.
 */
export const OWNERSHIP_BASE_ALLOWANCE = 1;
export const OWNERSHIP_MAX_ALLOWANCE = 2;
export const PAID_PRO_STATUSES = ["active", "past_due"] as const;
export type OwnershipQualifier = "PAID_PRO" | "COMP" | "LEGACY";
export type OwnershipAllowance = { owned: number; allowed: number; canCreate: boolean; qualifiedBy: OwnershipQualifier | null };

type Env = Record<string, string | undefined>;

/** A stored subscription unlocks ownership only if paid, in a permitted Stripe mode, and the Organization's own Customer. */
export function paidSubscriptionQualifies(
  sub: { status: string; livemode: boolean; stripeCustomerId: string },
  org: { stripeCustomerId: string | null },
  env: Env = process.env
): boolean {
  return (PAID_PRO_STATUSES as readonly string[]).includes(sub.status) && stripeModePermitted(sub.livemode, env) && org.stripeCustomerId !== null && sub.stripeCustomerId === org.stripeCustomerId;
}

/** The qualifier of one owned Organization (null: Free / trial / unpaid PRO). */
export function ownershipQualifier(org: { plan: OrganizationPlan; trialEndsAt: Date | null; hasPaidSubscription: boolean }, now: Date = new Date()): OwnershipQualifier | null {
  const plan = effectivePlan(org, now);
  if (plan === "COMP" || plan === "LEGACY") return plan;
  if (plan === "PRO" && org.hasPaidSubscription) return "PAID_PRO";
  return null;
}

const QUALIFIER_ORDER: readonly OwnershipQualifier[] = ["PAID_PRO", "COMP", "LEGACY"];

/** Read-only. Inside createOrganizationWorkspace it runs under the per-User workspace lock. */
export async function ownershipAllowance(userId: string, now: Date = new Date(), db: Db = prisma, env: Env = process.env): Promise<OwnershipAllowance> {
  const owned = await db.organizationMembership.findMany({
    where: { userId, role: "OWNER" },
    select: {
      organization: {
        select: {
          plan: true,
          trialEndsAt: true,
          stripeCustomerId: true,
          billingSubscriptions: { where: { status: { in: [...PAID_PRO_STATUSES] } }, select: { status: true, livemode: true, stripeCustomerId: true } },
        },
      },
    },
  });
  const qualifiers = new Set(
    owned.map(({ organization: o }) => ownershipQualifier({ ...o, hasPaidSubscription: o.billingSubscriptions.some((sub) => paidSubscriptionQualifies(sub, o, env)) }, now))
  );
  const qualifiedBy = QUALIFIER_ORDER.find((q) => qualifiers.has(q)) ?? null;
  const allowed = qualifiedBy ? OWNERSHIP_MAX_ALLOWANCE : OWNERSHIP_BASE_ALLOWANCE;
  return { owned: owned.length, allowed, canCreate: owned.length < allowed, qualifiedBy };
}

/** Why creation is unavailable (null when it is available). Only the User's own counts — no billing details. */
export function ownershipLimitMessage(a: OwnershipAllowance): string | null {
  if (a.canCreate) return null;
  const owns = `You already own ${a.owned} organization${a.owned === 1 ? "" : "s"}`;
  const join = "You can still join other organizations when you're invited.";
  if (a.allowed >= OWNERSHIP_MAX_ALLOWANCE) return `${owns}. An account can own at most ${OWNERSHIP_MAX_ALLOWANCE} organizations. ${join}`;
  return `${owns}. A second organization is available when an organization you own is on paid Pro, complimentary Pro or Early Access. ${join}`;
}

/** "Organizations owned: 1 of 2" (an owner above the allowance reads e.g. "3 of 2"). */
export const ownershipCountLabel = (a: OwnershipAllowance) => `Organizations owned: ${a.owned} of ${a.allowed}`;

/** Shown before creating a second Organization: plans and billing never carry over. */
export const SECOND_ORGANIZATION_NOTE = "A new organization starts on the Free plan, with its own separate billing. Pro on another organization doesn't carry over.";

/** The Organization-creation ownership limit (HTTP 409, code OWNERSHIP_LIMIT). */
export class OwnershipLimitError extends Error {
  readonly owned: number;
  readonly allowed: number;
  constructor(a: OwnershipAllowance) {
    super(ownershipLimitMessage(a) ?? "Organization limit reached.");
    this.name = "OwnershipLimitError";
    this.owned = a.owned;
    this.allowed = a.allowed;
  }
}

export function ownershipLimitResponse(e: OwnershipLimitError): NextResponse {
  return NextResponse.json({ error: e.message, code: "OWNERSHIP_LIMIT", owned: e.owned, allowed: e.allowed }, { status: 409 });
}

/** Telegram premium actions (connect a Telegram group, post polls / teams / post-game messages). */
export async function assertTelegram(organizationId: string, now: Date = new Date()): Promise<void> {
  const { plan, limits } = await organizationPlan(organizationId, now);
  if (!limits.telegram) {
    throw new EntitlementError("telegram", null, limitReachedMessage(plan, "Telegram integration is part of Pro; players use the match link"));
  }
}

/** Route helper: null when allowed, else the 402 response. */
export async function telegramDenied(organizationId: string): Promise<NextResponse | null> {
  try {
    await assertTelegram(organizationId);
    return null;
  } catch (e) {
    if (e instanceof EntitlementError) return planLimitResponse(e);
    throw e;
  }
}

/**
 * AI recap credit — reserve BEFORE the AI call (race-safe: per-Organization
 * lock; in-flight reservations count), then settle: success keeps the credit,
 * failure releases it. A reservation abandoned by a crash/timeout expires
 * after AI_RESERVATION_TTL_MS and is released here (never charged).
 */
export async function reserveAiCredit(input: { organizationId: string; groupId: string; matchId: string; userId: string | null }, now: Date = new Date()): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    await tx.aiUsage.updateMany({ where: { organizationId: input.organizationId, status: "RESERVED", expiresAt: { lte: now } }, data: { status: "RELEASED", settledAt: now } });
    const { plan, limits } = await organizationPlan(input.organizationId, now, tx);
    const limit = limits.monthlyAiRecaps;
    if (limit !== null && (await aiCreditsUsed(input.organizationId, now, tx)) >= limit) {
      const { next } = utcMonth(now);
      const reset = next.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
      throw new EntitlementError(
        "monthlyAiRecaps",
        limit,
        `${limitReachedMessage(plan, `${limit} AI recaps per month`)} Write or edit the recap yourself — AI recaps reset ${reset}.`
      );
    }
    const row = await tx.aiUsage.create({
      data: { ...input, period: utcMonth(now).period, status: "RESERVED", expiresAt: new Date(now.getTime() + AI_RESERVATION_TTL_MS) },
      select: { id: true },
    });
    return row.id;
  });
}

/** Settle a reservation exactly once (a second settle is a no-op). */
export async function settleAiCredit(id: string, succeeded: boolean, now: Date = new Date()): Promise<void> {
  await prisma.aiUsage.updateMany({ where: { id, status: "RESERVED" }, data: { status: succeeded ? "SUCCEEDED" : "RELEASED", settledAt: now } });
}

/** Read-only plan + usage summary (OWNER/ADMIN). */
export async function planSummary(organizationId: string, now: Date = new Date()) {
  const { plan, limits, trialEndsAt } = await organizationPlan(organizationId, now);
  const [usage, aiUsed] = await Promise.all([capacityUsage(organizationId, now), aiCreditsUsed(organizationId, now)]);
  return {
    plan,
    label: PLAN_LABEL[plan],
    trialEndsAt: plan === "TRIAL" && trialEndsAt ? trialEndsAt.toISOString() : null,
    trialDaysLeft: plan === "TRIAL" ? trialDaysLeft(trialEndsAt, now) : null,
    telegram: limits.telegram,
    usage: {
      activeGroups: { used: usage.activeGroups, limit: limits.activeGroups },
      activePlayers: { used: usage.activePlayers, limit: limits.activePlayers },
      monthlyMatches: { used: usage.monthlyMatches, limit: limits.monthlyMatches },
      activeSchedules: { used: usage.activeSchedules, limit: limits.activeSchedules },
      monthlyAiRecaps: { used: aiUsed, limit: limits.monthlyAiRecaps },
    },
    resetsAt: utcMonth(now).next.toISOString(),
  };
}

/**
 * M11.1 — the ONLY way to change an Organization's entitlement outside the
 * trial-on-creation flow (and, later, Stripe): an explicit, audited operator
 * action. Every change writes an EntitlementEvent in the same transaction.
 *   grant-comp     → COMP (approved internal/founder Organizations; never over a paid PRO)
 *   revoke-comp    → FREE (from COMP)
 *   trial          → FREE with the trial running until max(now, current end) + days
 *                    (a new or extended trial; also how a LEGACY Organization is moved onto the trial)
 *   set-free       → FREE, no trial (from LEGACY or COMP)
 * Never deletes or deactivates anything.
 */
export type EntitlementAction = "grant-comp" | "revoke-comp" | "trial" | "set-free";

export async function changeEntitlement(input: { organizationId: string; action: EntitlementAction; reason: string; actor: string; days?: number }, now: Date = new Date()) {
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  if (reason.length < 5) throw new Error("A reason (at least 5 characters) is required.");
  if (!actor) throw new Error("An actor is required.");
  return prisma.$transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { plan: true, trialEndsAt: true, trialStartedAt: true } });
    let data: Prisma.OrganizationUpdateInput;
    switch (input.action) {
      case "grant-comp":
        if (org.plan === "PRO") throw new Error("This Organization has a paid plan; complimentary Pro is not applied over it.");
        data = { plan: "COMP" };
        break;
      case "revoke-comp":
        if (org.plan !== "COMP") throw new Error("This Organization is not on complimentary Pro.");
        data = { plan: "FREE" };
        break;
      case "trial": {
        const days = input.days ?? 0;
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Trial days must be a whole number from 1 to 365.");
        if (org.plan === "PRO" || org.plan === "COMP") throw new Error(`This Organization is on ${org.plan}; a trial does not apply.`);
        const from = org.trialEndsAt && org.trialEndsAt > now ? org.trialEndsAt : now;
        data = { plan: "FREE", trialStartedAt: org.trialStartedAt ?? now, trialEndsAt: new Date(from.getTime() + days * 86_400_000) };
        break;
      }
      case "set-free":
        if (org.plan !== "LEGACY" && org.plan !== "COMP") throw new Error("Only LEGACY or COMP Organizations can be set to Free this way.");
        data = { plan: "FREE", trialEndsAt: null };
        break;
    }
    const updated = await tx.organization.update({ where: { id: input.organizationId }, data, select: { plan: true, trialEndsAt: true } });
    await tx.entitlementEvent.create({
      data: { organizationId: input.organizationId, action: input.action.toUpperCase().replace("-", "_"), fromPlan: org.plan, toPlan: updated.plan, trialEndsAt: updated.trialEndsAt, reason, actor },
    });
    return updated;
  });
}
