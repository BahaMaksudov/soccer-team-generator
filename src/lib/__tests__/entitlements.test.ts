import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import {
  effectivePlan,
  limitReachedMessage,
  OWNERSHIP_BASE_ALLOWANCE,
  OWNERSHIP_MAX_ALLOWANCE,
  OwnershipLimitError,
  ownershipCountLabel,
  ownershipLimitMessage,
  ownershipLimitResponse,
  ownershipQualifier,
  paidSubscriptionQualifies,
  PAID_PRO_STATUSES,
  PLAN_LIMITS,
  PLAN_LABEL,
  TRIAL_DAYS,
  trialDaysLeft,
  utcMonth,
} from "@/lib/entitlements";
import { ENTITLING_STATUSES } from "@/lib/billing/sync";
import { aiUsageText } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection";
import PlanUsageCard from "@/app/admin/o/[organizationSlug]/PlanUsageCard";

/** M11.1 — the plan catalog and pure entitlement rules. */
describe("plan catalog (approved launch limits)", () => {
  it("Free / Pro / trial / complimentary / legacy", () => {
    expect(PLAN_LIMITS.FREE).toEqual({ activeGroups: 1, activePlayers: 30, monthlyMatches: 4, activeSchedules: 1, monthlyAiRecaps: 2, telegram: false, rsvpEmailsPerMonth: 100, rsvpEmailsPerDay: 20 });
    expect(PLAN_LIMITS.PRO).toEqual({ activeGroups: 3, activePlayers: 150, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: 30, telegram: true, rsvpEmailsPerMonth: 500, rsvpEmailsPerDay: 50 });
    // The trial keeps every Pro entitlement except the RSVP email allowance (Free's, M13B).
    expect(PLAN_LIMITS.TRIAL).toEqual({ ...PLAN_LIMITS.PRO, rsvpEmailsPerMonth: 100, rsvpEmailsPerDay: 20 });
    expect(PLAN_LIMITS.COMP).toEqual(PLAN_LIMITS.PRO);
    expect(PLAN_LIMITS.LEGACY).toEqual({ activeGroups: null, activePlayers: null, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: null, telegram: true, rsvpEmailsPerMonth: 500, rsvpEmailsPerDay: 50 });
    expect(TRIAL_DAYS).toBe(90);
    expect(PLAN_LABEL.TRIAL).toBe("Pro trial");
  });
});

describe("effective plan", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  it("FREE with a running trial is TRIAL; an ended trial is FREE; other plans are themselves", () => {
    expect(effectivePlan({ plan: "FREE", trialEndsAt: new Date("2026-10-09T12:00:01Z") }, now)).toBe("TRIAL");
    expect(effectivePlan({ plan: "FREE", trialEndsAt: new Date("2026-10-09T12:00:00Z") }, now)).toBe("FREE"); // ends exactly now
    expect(effectivePlan({ plan: "FREE", trialEndsAt: null }, now)).toBe("FREE");
    for (const p of ["PRO", "COMP", "LEGACY"] as const) expect(effectivePlan({ plan: p, trialEndsAt: new Date("2000-01-01") }, now)).toBe(p);
  });
  it("trial days left (rounded up) and none after expiry", () => {
    expect(trialDaysLeft(new Date(now.getTime() + 89.2 * 86_400_000), now)).toBe(90);
    expect(trialDaysLeft(new Date(now.getTime() + 1000), now)).toBe(1);
    expect(trialDaysLeft(new Date(now.getTime() - 1000), now)).toBeNull();
    expect(trialDaysLeft(null, now)).toBeNull();
  });
});

describe("UTC calendar month", () => {
  it("period key, start and reset (year rollover, no local-time drift)", () => {
    expect(utcMonth(new Date("2026-10-31T23:59:59Z"))).toEqual({ period: "2026-10", start: new Date("2026-10-01T00:00:00Z"), next: new Date("2026-11-01T00:00:00Z") });
    expect(utcMonth(new Date("2026-12-15T05:00:00Z")).next).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(utcMonth(new Date("2026-11-01T00:00:00Z")).period).toBe("2026-11");
  });
});

describe("limit messages (no upgrade action until Stripe)", () => {
  it("Free names the limit; 'coming soon' while billing is off, the Billing page once it's on; other plans just name the limit", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect(limitReachedMessage("FREE", "30 active players")).toBe("Your Free plan limit has been reached (30 active players). Pro plans and upgrades are coming soon.");
    expect(limitReachedMessage("TRIAL", "3 active groups")).toBe("Your Pro trial plan limit has been reached (3 active groups).");
    expect(limitReachedMessage("COMP", "150 active players")).toBe("Your Pro (complimentary) plan limit has been reached (150 active players).");
    vi.stubEnv("BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_x");
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_m");
    vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_y");
    expect(limitReachedMessage("FREE", "30 active players")).toBe("Your Free plan limit has been reached (30 active players). Upgrade to Pro on your organization's Billing page.");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x"); // a live key never enables billing → back to "coming soon"
    expect(limitReachedMessage("FREE", "1 active group")).toMatch(/coming soon/);
    vi.unstubAllEnvs();
  });
});

describe("usage wording", () => {
  it("AI credits: remaining, exhausted, unlimited", () => {
    expect(aiUsageText({ used: 1, limit: 2, resetsAt: "2026-11-01T00:00:00.000Z" })).toBe("AI recaps: 1 of 2 used this month · resets Nov 1.");
    expect(aiUsageText({ used: 2, limit: 2, resetsAt: "2026-11-01T00:00:00.000Z" })).toMatch(/all 2 used this month · resets Nov 1\. You can still write/);
    expect(aiUsageText({ used: 5, limit: null, resetsAt: "2026-11-01T00:00:00.000Z" })).toBe("AI recaps: 5 used this month.");
  });
  it("plan card: read-only (no Upgrade / Manage Billing), trial countdown, limits and 'no limit'", () => {
    const usage = (used: number, limit: number | null) => ({ used, limit });
    const html = renderToStaticMarkup(
      createElement(PlanUsageCard, {
        summary: {
          plan: "TRIAL", label: "Pro trial", trialEndsAt: "2027-01-07T00:00:00.000Z", trialDaysLeft: 90, telegram: true, resetsAt: "2026-11-01T00:00:00.000Z",
          trialPhase: "active", trialEndedAt: null, trialEndsLabel: "Jan 6, 2027, 7:00 PM EST", billingEnabled: false, upgradeHint: "Pro plans and upgrades are coming soon.",
          usage: { activeGroups: usage(1, 3), activePlayers: usage(31, 150), monthlyMatches: usage(4, null), activeSchedules: usage(1, null), monthlyAiRecaps: usage(3, 30) },
        },
      })
    );
    expect(html).toContain("Pro trial");
    expect(html).toContain("90 days left");
    expect(html).toContain("31 of 150");
    expect(html).toContain("4 · no limit");
    // M11.3 — billing off: the honest "coming soon" hint, never an upgrade action.
    expect(html).not.toMatch(/Upgrade to Pro|Manage billing|button|href/i);
    expect(html).toContain("Pro plans and upgrades are coming soon.");
  });
});

describe("enforcement wiring (source checks)", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("every Telegram send/connect action checks the plan AFTER the role check", () => {
    for (const f of ["src/lib/telegramChannels.ts", "src/lib/telegramAttendance.ts", "src/lib/telegramCloseAndPost.ts", "src/lib/telegramAdmin.ts"]) {
      const s = read(f);
      const role = s.indexOf("if (denied) return denied;\n  // M11.1");
      expect(role, f).toBeGreaterThan(-1);
      expect(s.indexOf("telegramDenied(context.organization.id)", role), f).toBeGreaterThan(role);
    }
    const pg = read("src/lib/postGame.ts");
    expect(pg.match(/telegramDenied\(context\.organization\.id\)/g)).toHaveLength(2); // start_mvp, post_message
  });
  it("capacity checks run in the same transaction as the write", () => {
    expect(read("src/lib/playerCrud.ts")).toMatch(/assertCapacity\(tx, context\.organization\.id, "activePlayers"\)/);
    expect(read("src/lib/matches.ts")).toMatch(/assertCapacity\(tx, context\.organization\.id, "monthlyMatches"\)/);
    expect(read("src/lib/matchAutomation.ts")).toMatch(/assertCapacity\(tx, ctx\.organization\.id, "monthlyMatches", now\)/);
    expect(read("src/lib/schedules.ts").match(/assertCapacity\(tx, context\.organization\.id, "activeSchedules"\)/g)).toHaveLength(2);
    expect(read("src/lib/workspaces.ts")).toMatch(/assertCapacity\(tx, organizationId, "activeGroups", now\)/);
  });
});

describe("Phase 1 — organization ownership allowance (pure rules)", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const q = (plan: "FREE" | "PRO" | "COMP" | "LEGACY", over: { trialEndsAt?: Date | null; paid?: boolean } = {}) =>
    ownershipQualifier({ plan, trialEndsAt: over.trialEndsAt ?? null, hasPaidSubscription: over.paid ?? false }, now);

  it("1 by default, 2 at most", () => {
    expect([OWNERSHIP_BASE_ALLOWANCE, OWNERSHIP_MAX_ALLOWANCE]).toEqual([1, 2]);
  });
  it("qualifying: paid Pro (with a paid subscription), complimentary Pro, Legacy / Early Access", () => {
    expect(q("PRO", { paid: true })).toBe("PAID_PRO");
    expect(q("COMP")).toBe("COMP");
    expect(q("LEGACY")).toBe("LEGACY");
  });
  it("not qualifying: Free, the introductory trial, and a raw PRO value without a paid subscription", () => {
    expect(q("FREE")).toBeNull();
    expect(q("FREE", { trialEndsAt: new Date(now.getTime() + 86_400_000) })).toBeNull(); // running trial
    expect(q("FREE", { trialEndsAt: new Date(now.getTime() - 86_400_000) })).toBeNull(); // trial over
    expect(q("PRO")).toBeNull();
  });
  it("paid statuses = Stripe's entitling statuses minus trialing (past_due payment grace kept)", () => {
    expect([...PAID_PRO_STATUSES]).toEqual(ENTITLING_STATUSES.filter((s) => s !== "trialing"));
    expect(PAID_PRO_STATUSES).toContain("past_due");
    expect(PAID_PRO_STATUSES).not.toContain("trialing");
  });
  it("a stored subscription qualifies only if paid, in a permitted Stripe mode, and the Organization's own Customer", () => {
    const org = { stripeCustomerId: "cus_1" };
    const sub = { status: "active", livemode: false, stripeCustomerId: "cus_1" };
    expect(paidSubscriptionQualifies(sub, org, { VERCEL_ENV: "preview" })).toBe(true);
    expect(paidSubscriptionQualifies(sub, org, {})).toBe(true);
    expect(paidSubscriptionQualifies({ ...sub, status: "past_due" }, org, {})).toBe(true);
    expect(paidSubscriptionQualifies(sub, org, { VERCEL_ENV: "production" })).toBe(false); // test mode in Production
    expect(paidSubscriptionQualifies({ ...sub, livemode: true }, org, { BILLING_ALLOW_LIVE_MODE: "true" })).toBe(false); // live not launched
    expect(paidSubscriptionQualifies({ ...sub, livemode: true }, org, { VERCEL_ENV: "production", BILLING_ALLOW_LIVE_MODE: "true" })).toBe(false);
    expect(paidSubscriptionQualifies({ ...sub, stripeCustomerId: "cus_other" }, org, {})).toBe(false); // mismatched Customer
    expect(paidSubscriptionQualifies(sub, { stripeCustomerId: null }, {})).toBe(false);
    for (const status of ["trialing", "canceled", "unpaid", "incomplete", "paused"]) expect(paidSubscriptionQualifies({ ...sub, status }, org, {}), status).toBe(false);
  });
  it("messages: count label, reason without billing details, available → no message", () => {
    expect(ownershipCountLabel({ owned: 1, allowed: 2, canCreate: true, qualifiedBy: "LEGACY" })).toBe("Organizations owned: 1 of 2");
    expect(ownershipLimitMessage({ owned: 0, allowed: 1, canCreate: true, qualifiedBy: null })).toBeNull();
    const one = ownershipLimitMessage({ owned: 1, allowed: 1, canCreate: false, qualifiedBy: null })!;
    expect(one).toMatch(/^You already own 1 organization\. A second organization is available when an organization you own is on paid Pro, complimentary Pro or Early Access\./);
    expect(one).toContain("join other organizations");
    expect(ownershipLimitMessage({ owned: 2, allowed: 2, canCreate: false, qualifiedBy: "COMP" })).toMatch(/^You already own 2 organizations\. An account can own at most 2 organizations\./);
    expect(ownershipLimitMessage({ owned: 3, allowed: 1, canCreate: false, qualifiedBy: null })).toMatch(/^You already own 3 organizations\./); // over-limit owner
  });
  it("API shape: 409 OWNERSHIP_LIMIT with the User's own counts only", async () => {
    const res = ownershipLimitResponse(new OwnershipLimitError({ owned: 1, allowed: 1, canCreate: false, qualifiedBy: null }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["allowed", "code", "error", "owned"]);
    expect(body).toMatchObject({ code: "OWNERSHIP_LIMIT", owned: 1, allowed: 1 });
  });
  it("wiring: checked under the per-User lock, AFTER the replay check; the trial only for a first owned Organization", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/workspaces.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function createOrganizationWorkspace"), src.indexOf("export const createGroupSchema"));
    const lock = fn.indexOf('hashtext(${"workspace:" + ownerUserId})');
    const replay = fn.indexOf("if (recent && recent.groups.length === 1)");
    const check = fn.indexOf("const allowance = await ownershipAllowance(ownerUserId, now, tx);");
    const create = fn.indexOf("tx.organization.create(");
    expect(lock).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(replay);
    expect(create).toBeGreaterThan(check);
    expect(fn).toContain("if (!allowance.canCreate) throw new OwnershipLimitError(allowance);");
    expect(fn).toMatch(/allowance\.owned === 0\s*\?\s*await tx\.user\.updateMany\(\{ where: \{ id: ownerUserId, trialUsedAt: null, emailVerifiedAt: \{ not: null \} \}/);
    expect(fs.readFileSync(path.join(process.cwd(), "src/lib/tenantRoute.ts"), "utf8")).toContain("if (e instanceof OwnershipLimitError) return ownershipLimitResponse(e);");
  });
});

describe("Phase 2 — Free monthly matches and skipped recurring-match warnings", () => {
  it("Free allows 4 new matches per month; trial / Pro / complimentary / legacy are unlimited", () => {
    expect(PLAN_LIMITS.FREE.monthlyMatches).toBe(4);
    for (const p of ["TRIAL", "PRO", "COMP", "LEGACY"] as const) expect(PLAN_LIMITS[p].monthlyMatches, p).toBeNull();
  });
  it("the warning names the occurrence and the reason, says the schedule is still active, and never says canceled", async () => {
    vi.stubEnv("BILLING_ENABLED", "");
    const { scheduleSkipMessage } = await import("@/lib/scheduleSkips");
    const text = scheduleSkipMessage({ occurrenceDate: new Date("2026-10-31T00:00:00Z"), monthlyLimit: 4 });
    expect(text).toBe(
      "Your Free plan allows 4 new matches per month. The match scheduled for October 31, 2026 was not created because your monthly limit was reached. Your recurring schedule is still active. Pro plans with unlimited matches are coming soon."
    );
    expect(text).not.toMatch(/cancel/i);
    vi.unstubAllEnvs();
  });
  it("wiring: automation records the skip on the plan limit (same UTC-month instant) and resolves it when the match is created", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/matchAutomation.ts"), "utf8");
    expect(src).toContain('if (e.metric === "monthlyMatches" && e.limit !== null) await recordScheduleSkip(');
    expect(src).toMatch(/created = true;\s*await resolveScheduleSkip\(s\.id, date, now\);/);
  });
});
