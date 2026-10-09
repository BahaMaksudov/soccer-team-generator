import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { effectivePlan, limitReachedMessage, PLAN_LIMITS, PLAN_LABEL, TRIAL_DAYS, trialDaysLeft, utcMonth } from "@/lib/entitlements";
import { aiUsageText } from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/PostGameSection";
import PlanUsageCard from "@/app/admin/o/[organizationSlug]/PlanUsageCard";

/** M11.1 — the plan catalog and pure entitlement rules. */
describe("plan catalog (approved launch limits)", () => {
  it("Free / Pro / trial / complimentary / legacy", () => {
    expect(PLAN_LIMITS.FREE).toEqual({ activeGroups: 1, activePlayers: 30, monthlyMatches: 8, activeSchedules: 1, monthlyAiRecaps: 2, telegram: false });
    expect(PLAN_LIMITS.PRO).toEqual({ activeGroups: 3, activePlayers: 150, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: 30, telegram: true });
    expect(PLAN_LIMITS.TRIAL).toEqual(PLAN_LIMITS.PRO);
    expect(PLAN_LIMITS.COMP).toEqual(PLAN_LIMITS.PRO);
    expect(PLAN_LIMITS.LEGACY).toEqual({ activeGroups: null, activePlayers: null, monthlyMatches: null, activeSchedules: null, monthlyAiRecaps: null, telegram: true });
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
          usage: { activeGroups: usage(1, 3), activePlayers: usage(31, 150), monthlyMatches: usage(4, null), activeSchedules: usage(1, null), monthlyAiRecaps: usage(3, 30) },
        },
      })
    );
    expect(html).toContain("Pro trial");
    expect(html).toContain("90 days left");
    expect(html).toContain("31 of 150");
    expect(html).toContain("4 · no limit");
    expect(html).not.toMatch(/Upgrade|Manage billing|button/i);
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
    expect(read("src/lib/matchAutomation.ts")).toMatch(/assertCapacity\(tx, ctx\.organization\.id, "monthlyMatches"\)/);
    expect(read("src/lib/schedules.ts").match(/assertCapacity\(tx, context\.organization\.id, "activeSchedules"\)/g)).toHaveLength(2);
    expect(read("src/lib/workspaces.ts")).toMatch(/assertCapacity\(tx, organizationId, "activeGroups", now\)/);
  });
});
