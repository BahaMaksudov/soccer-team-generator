import { NextResponse } from "next/server";
import type { OrganizationPlan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { billingConfig, stripeModePermitted } from "@/lib/billing/config";
import { isValidTimeZone } from "@/lib/scheduleTime";

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
  /**
   * M13B — RSVP invitation recipient emails per organization, per UTC calendar
   * month / day (owner-approved: Free 100 / 20; paid and LEGACY 500 / 50). Shown
   * in the P2 preview; enforced when sending exists (P4).
   */
  rsvpEmailsPerMonth: number;
  rsvpEmailsPerDay: number;
};
export type CapacityMetric = "activeGroups" | "activePlayers" | "monthlyMatches" | "activeSchedules";

const FREE: Limits = { activeGroups: 1, activePlayers: 30, monthlyMatches: 4, activeSchedules: 1, monthlyAiRecaps: 2, telegram: false, rsvpEmailsPerMonth: 100, rsvpEmailsPerDay: 20 };
const PRO: Limits = { activeGroups: 3, activePlayers: 150, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: 30, telegram: true, rsvpEmailsPerMonth: 500, rsvpEmailsPerDay: 50 };
// LEGACY keeps "no limits" for existing features; RSVP email is new and gets the paid allowance (owner decision).
const UNLIMITED: Limits = { activeGroups: null, activePlayers: null, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: null, telegram: true, rsvpEmailsPerMonth: 500, rsvpEmailsPerDay: 50 };

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

/** M13B — the UTC calendar day containing `now` (RSVP daily allowance window). */
export function utcDay(now: Date = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { period: start.toISOString().slice(0, 10), start, next };
}

export function trialDaysLeft(trialEndsAt: Date | null, now: Date = new Date()): number | null {
  if (!trialEndsAt || trialEndsAt.getTime() <= now.getTime()) return null;
  return Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000);
}

/**
 * M11.3 — the trial as an Organization sees it (pure; UTC instants). Only a FREE
 * Organization with a trial end has a trial; LEGACY / COMP / PRO never do.
 *   active   → more than TRIAL_ENDING_DAYS left;
 *   ending   → TRIAL_ENDING_DAYS or fewer left (banner + reminders);
 *   expired  → trialEndsAt <= now: the Free plan applies from that exact instant.
 */
export const TRIAL_ENDING_DAYS = 14;
export type TrialPhase = "none" | "active" | "ending" | "expired";
export type TrialStatus = { phase: TrialPhase; endsAt: Date | null; daysLeft: number | null };

export function trialStatus(org: { plan: OrganizationPlan; trialEndsAt: Date | null }, now: Date = new Date()): TrialStatus {
  if (org.plan !== "FREE" || !org.trialEndsAt) return { phase: "none", endsAt: null, daysLeft: null };
  const daysLeft = trialDaysLeft(org.trialEndsAt, now);
  if (daysLeft === null) return { phase: "expired", endsAt: org.trialEndsAt, daysLeft: null };
  return { phase: daysLeft <= TRIAL_ENDING_DAYS ? "ending" : "active", endsAt: org.trialEndsAt, daysLeft };
}

/**
 * The one date format of trial texts. The instant is UTC-authoritative (trialEndsAt);
 * it is SHOWN in the organization's timezone, with the zone named, e.g.
 * "Jan 31, 2027, 5:30 AM EST" — so a customer never misreads the day.
 */
export const trialDateLabel = (d: Date, timeZone: string = "UTC") =>
  d.toLocaleString("en-US", { timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/**
 * An Organization has no timezone of its own: its display timezone is that of its
 * first active Group (else its first Group), else UTC. Display only — never used
 * to decide when a trial ends.
 */
export async function organizationTimeZone(organizationId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
  const g = await db.group.findFirst({ where: { organizationId }, orderBy: [{ isActive: "desc" }, { createdAt: "asc" }], select: { timezone: true } });
  return g && isValidTimeZone(g.timezone) ? g.timezone : "UTC";
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
export const SECOND_ORGANIZATION_NOTE = "A new organization starts on the Free plan, with its own separate billing. The 90-day Pro trial is once per account, and Pro on another organization doesn't carry over.";

/**
 * M11.3 — THE trial eligibility policy (one place for the wording): one standard
 * 90-day Pro trial per customer account, claimed by the account's first
 * Organization at creation (verified email required). Additional Organizations
 * never get another trial.
 */
export const TRIAL_POLICY_NOTE = `Your first organization includes the ${TRIAL_DAYS}-day Pro trial — one trial per account, no card required. Nothing is charged when it ends; the organization moves to Free.`;

/** Whether this User's next Organization would get the trial (display only; workspaces.ts enforces it atomically). */
export async function trialAvailableFor(userId: string, db: Db = prisma): Promise<boolean> {
  const [user, owned] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { trialUsedAt: true, emailVerifiedAt: true } }),
    db.organizationMembership.count({ where: { userId, role: "OWNER" } }),
  ]);
  return Boolean(user && !user.trialUsedAt && user.emailVerifiedAt && owned === 0);
}

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

/** Optional support contact (SUPPORT_EMAIL) for "coming soon" texts — see src/lib/support.ts. */
export { supportEmail } from "@/lib/support";
import { supportEmail } from "@/lib/support";

/** What a Free Organization can do about Pro right now: the Billing page once billing is on, else "coming soon" (+ contact). */
export function upgradeHint(env: Env = process.env): string {
  if (billingConfig().enabled) return FREE_LIMIT_UPGRADE;
  const contact = supportEmail(env);
  return contact ? `${FREE_LIMIT_COMING_SOON} Questions? Contact ${contact}.` : FREE_LIMIT_COMING_SOON;
}

/**
 * M11.3 — why Telegram is unavailable, in words an organizer understands (never a generic error).
 * After the trial: when it ended, that nothing was deleted, and what still works.
 */
export function telegramNotInPlanMessage(org: { plan: OrganizationPlan; trialEndsAt: Date | null }, now: Date = new Date(), env: Env = process.env, timeZone: string = "UTC"): string {
  const trial = trialStatus(org, now);
  const why =
    trial.phase === "expired" && trial.endsAt
      ? `This organization's Pro trial ended on ${trialDateLabel(trial.endsAt, timeZone)}, so it is now on the Free plan. Players can still answer through the match link, and existing polls, messages and connected Telegram groups are kept.`
      : "This organization is on the Free plan; players can answer through the match link.";
  return `Telegram integration is part of Pro. ${why} ${upgradeHint(env)}`;
}

/** Telegram premium actions (connect a Telegram group, post or close polls, post teams / post-game messages, Game Day Updates). */
export async function assertTelegram(organizationId: string, now: Date = new Date(), db: Db = prisma): Promise<void> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, trialEndsAt: true } });
  if (!PLAN_LIMITS[effectivePlan(org, now)].telegram) {
    throw new EntitlementError("telegram", null, telegramNotInPlanMessage(org, now, process.env, await organizationTimeZone(organizationId, db)));
  }
}

/**
 * M11.3 — since when the Organization has had Telegram WITHOUT a break, as far as
 * the audit trail (EntitlementEvent) proves. Automation only: a Pro-only AUTOMATIC
 * Telegram send whose due time fell before this instant was due while the
 * Organization was not entitled — it is skipped, never sent late after an upgrade.
 * Manual organizer actions are not restricted by it.
 *   null → no restriction (LEGACY, or entitled with no recorded grant / start).
 *   Trial → the start of the trial; after an operator "trial" action, that action
 *           (continuity before it can't be proven → conservative).
 *   PRO / COMP → the latest grant (Stripe Pro started / complimentary granted),
 *           unless it happened while the trial was still running (continuous since
 *           the trial start).
 * Not entitled now → null (nothing automatic is sent anyway).
 */
export const GRANT_ACTIONS = ["STRIPE_PRO_STARTED", "GRANT_COMP"] as const;
const CONVERSION_TOLERANCE_MS = 60_000; // the trial end and the grant event are written in one transaction

export async function telegramEntitledSince(organizationId: string, now: Date = new Date(), db: Db = prisma): Promise<Date | null> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { plan: true, trialStartedAt: true, trialEndsAt: true } });
  const plan = effectivePlan(org, now);
  if (!PLAN_LIMITS[plan].telegram || plan === "LEGACY") return null;
  const latest = (actions: readonly string[]) =>
    db.entitlementEvent.findFirst({ where: { organizationId, action: { in: [...actions] }, createdAt: { lte: now } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (plan === "TRIAL") return (await latest(["TRIAL"]))?.createdAt ?? org.trialStartedAt ?? null;
  const grant = await latest(GRANT_ACTIONS);
  if (!grant) return null;
  const at = grant.createdAt.getTime();
  const duringTrial = org.trialEndsAt !== null && org.trialEndsAt.getTime() >= at - CONVERSION_TOLERANCE_MS && (!org.trialStartedAt || org.trialStartedAt.getTime() <= at);
  return duringTrial ? (org.trialStartedAt ?? null) : grant.createdAt;
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

/**
 * Phase 2 — the monthly new-match allowance for the Matches page (OWNER/ADMIN):
 * same plan, counting rule (Matches created in the current UTC calendar month,
 * canceled included) and reset as assertCapacity. limit null = unlimited.
 */
export async function monthlyMatchAllowance(organizationId: string, now: Date = new Date()) {
  const { plan, limits } = await organizationPlan(organizationId, now);
  const limit = limits.monthlyMatches;
  const used = (await capacityUsage(organizationId, now)).monthlyMatches;
  const exhausted = limit !== null && used >= limit;
  return {
    plan,
    label: PLAN_LABEL[plan],
    used,
    limit,
    exhausted,
    resetsAt: utcMonth(now).next.toISOString(),
    message: exhausted ? limitReachedMessage(plan, NOUN.monthlyMatches(limit)) : null,
  };
}

/** Read-only plan + usage summary (OWNER/ADMIN). */
export async function planSummary(organizationId: string, now: Date = new Date()) {
  const { plan, limits, trialEndsAt } = await organizationPlan(organizationId, now);
  const [usage, aiUsed] = await Promise.all([capacityUsage(organizationId, now), aiCreditsUsed(organizationId, now)]);
  const trial = trialStatus({ plan: plan === "TRIAL" || plan === "FREE" ? "FREE" : plan, trialEndsAt }, now);
  const timeZone = trial.endsAt ? await organizationTimeZone(organizationId) : "UTC";
  return {
    // M11.3 — display labels in the organization's timezone (the instants stay UTC).
    trialEndsLabel: trial.endsAt ? trialDateLabel(trial.endsAt, timeZone) : null,
    plan,
    label: PLAN_LABEL[plan],
    // M11.3 — "active" | "ending" | "expired" | "none"; the end date also after expiry (Free plan explanation).
    trialPhase: trial.phase,
    trialEndedAt: trial.phase === "expired" && trialEndsAt ? trialEndsAt.toISOString() : null,
    billingEnabled: billingConfig().enabled,
    upgradeHint: plan === "FREE" || plan === "TRIAL" ? upgradeHint() : null,
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
