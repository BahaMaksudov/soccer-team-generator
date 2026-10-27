import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { EntitlementError, planLimitMessage, planLimitResponse, telegramNotInPlanMessage, PLAN_LIMITS } from "@/lib/entitlements";
import PlanLimitNotice, { PlanLimitProvider, planLimitFrom, type PlanLimitViewer } from "@/components/billing/PlanLimitNotice";
import { planFeatures } from "@/components/billing/PricingPlans";
import PlanComparison from "@/components/billing/PlanComparison";
import GameDayUpdateSection from "@/app/admin/o/[organizationSlug]/g/[groupSlug]/settings/GameDayUpdateSection";
import { GAME_DAY_UPDATE_DEFAULTS } from "@/lib/gameDayUpdateSettings";

/** Fix A — Free/Pro limit messages and the shared upgrade notice (offline). */
const billingOn = () => {
  vi.stubEnv("BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_x");
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_m");
  vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_y");
  vi.stubEnv("VERCEL_ENV", "");
};
afterEach(() => vi.unstubAllEnvs());
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

describe("server messages: Free names its allowance and what Pro adds (from PLAN_LIMITS)", () => {
  it("billing on: one message per limit", () => {
    billingOn();
    const head = "You've reached your Free plan limit.";
    expect(planLimitMessage("FREE", "activeGroups")).toBe(`${head} Your Free plan allows 1 group. Upgrade to Pro to manage up to 3 groups.`);
    expect(planLimitMessage("FREE", "activePlayers")).toBe(`${head} Your Free plan allows 30 players per organization. Upgrade to Pro for up to 150 players per organization.`);
    expect(planLimitMessage("FREE", "monthlyMatches")).toBe(`${head} Your Free plan allows 4 matches per month. Upgrade to Pro for unlimited matches.`);
    expect(planLimitMessage("FREE", "activeSchedules")).toBe(`${head} Your Free plan allows 1 active recurring schedule. Upgrade to Pro for unlimited recurring schedules.`);
    expect(planLimitMessage("FREE", "monthlyAiRecaps")).toBe(`${head} Your Free plan includes 2 AI recaps per month. Upgrade to Pro for 30 per month.`);
    expect(telegramNotInPlanMessage({ plan: "FREE", trialEndsAt: null }, new Date(), process.env)).toBe(
      "Telegram integration is available with Pro. This organization is on the Free plan; players can answer through the match link. Upgrade to Pro to connect Telegram."
    );
  });
  it("billing off: the allowance plus 'coming soon' — never an upgrade offer", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    for (const m of ["activeGroups", "activePlayers", "monthlyMatches", "activeSchedules", "monthlyAiRecaps"] as const) {
      const msg = planLimitMessage("FREE", m);
      expect(msg, m).toMatch(/^You've reached your Free plan limit\. Your Free plan (allows|includes) .+\. Pro plans and upgrades are coming soon\.$/);
      expect(msg, m).not.toMatch(/Upgrade to Pro/);
    }
  });
  it("Pro / trial / complimentary: the plain limit, no upgrade offer; players say 'per organization'", () => {
    billingOn();
    expect(planLimitMessage("PRO", "activeGroups")).toBe("Your Pro plan limit has been reached (3 active groups).");
    expect(planLimitMessage("PRO", "activePlayers")).toBe("Your Pro plan limit has been reached (150 active players per organization).");
    expect(planLimitMessage("PRO", "monthlyAiRecaps")).toBe("Your Pro plan limit has been reached (30 AI recaps per month).");
    expect(planLimitMessage("TRIAL", "activeGroups")).toBe("Your Pro trial plan limit has been reached (3 active groups).");
    expect(planLimitMessage("COMP", "activePlayers")).toMatch(/^Your Pro \(complimentary\) plan limit has been reached/);
    for (const p of ["PRO", "TRIAL", "COMP"] as const) expect(planLimitMessage(p, "activeGroups")).not.toMatch(/Upgrade/);
  });
  it("402 PLAN_LIMIT keeps its code and adds the plan and Pro's allowance (null = unlimited / not numeric)", async () => {
    const cases = [["activeGroups", 3], ["activePlayers", 150], ["monthlyMatches", null], ["activeSchedules", null], ["monthlyAiRecaps", 30], ["telegram", null]] as const;
    for (const [metric, proLimit] of cases) {
      const e = new EntitlementError(metric, metric === "telegram" ? null : (PLAN_LIMITS.FREE[metric] as number), "msg", "FREE");
      expect(e.proLimit, metric).toBe(proLimit);
      const res = planLimitResponse(e);
      expect(res.status).toBe(402);
      expect(await res.json(), metric).toEqual({ error: "msg", code: "PLAN_LIMIT", metric, limit: metric === "telegram" ? null : PLAN_LIMITS.FREE[metric], plan: "FREE", proLimit });
    }
  });
});

describe("PlanLimitNotice — the right next step for each viewer", () => {
  const ownerFree: PlanLimitViewer = { upgradeHref: "/admin/o/club/billing", isOwner: true, billingEnabled: true, plan: "FREE", supportEmail: "support@teambalancepro.com" };
  const render = (viewer: PlanLimitViewer | null, props: { message: string; plan?: string | null }) =>
    renderToStaticMarkup(createElement(PlanLimitProvider, { value: viewer } as Parameters<typeof PlanLimitProvider>[0], createElement(PlanLimitNotice, props)));
  const MSG = "You've reached your Free plan limit. Your Free plan allows 1 group. Upgrade to Pro to manage up to 3 groups.";

  it("Free OWNER (billing on): the message and an Upgrade to Pro link to THIS organization's Billing page — a link, never a Checkout call", () => {
    const html = render(ownerFree, { message: MSG, plan: "FREE" });
    expect(html).toMatch(/^<div role="alert"/);
    expect(html).toContain("Your Free plan allows 1 group.");
    expect(html).toMatch(/<a href="\/admin\/o\/club\/billing"[^>]*>Upgrade to Pro/);
    expect(html).not.toMatch(/checkout|stripe/i);
    expect(html).not.toContain("Ask your organization owner");
    expect(html).toMatch(/min-h-10/); // touch-sized on mobile
    expect(html).toMatch(/focus-visible:ring-2/); // keyboard focus visible
  });
  it("ADMIN (or anyone not the owner): ask-the-owner guidance, no upgrade link", () => {
    const html = render({ ...ownerFree, upgradeHref: null, isOwner: false }, { message: MSG, plan: "FREE" });
    expect(html).toContain("Ask your organization owner to upgrade to Pro.");
    expect(html).not.toContain("<a href=");
  });
  it("Pro (and trial / complimentary) limits: no upgrade action; a support contact when configured", () => {
    for (const plan of ["PRO", "TRIAL", "COMP"]) {
      const html = render(ownerFree, { message: "Your Pro plan limit has been reached (3 active groups).", plan });
      expect(html, plan).not.toContain("Upgrade to Pro");
      expect(html, plan).toContain('href="mailto:support@teambalancepro.com"');
    }
    expect(render({ ...ownerFree, supportEmail: null }, { message: "x", plan: "PRO" })).not.toContain("mailto:");
  });
  it("the server-reported plan wins over the page's (a stale Free page never offers an upgrade to a Pro org)", () => {
    expect(render(ownerFree, { message: "x", plan: "PRO" })).not.toContain("Upgrade to Pro");
    expect(render({ ...ownerFree, plan: "PRO" }, { message: MSG })).not.toContain(">Upgrade to Pro"); // falls back to the page's plan
  });
  it("billing off: no upgrade link and no ask-owner line; outside an organization page: the message only", () => {
    const off = render({ ...ownerFree, billingEnabled: false, upgradeHref: null }, { message: "coming soon", plan: "FREE" });
    expect(off).not.toContain("<a href=");
    expect(off).not.toContain("Ask your organization owner");
    expect(render(null, { message: MSG, plan: "FREE" })).toBe(`<div role="alert" class="rounded-tbp border border-accent/40 bg-accent/10 px-3 py-2 text-sm"><p class="break-words">${MSG.replace(/'/g, "&#x27;")}</p></div>`);
  });
  it("planLimitFrom: only a 402 PLAN_LIMIT body", () => {
    expect(planLimitFrom({ code: "PLAN_LIMIT", error: "m", plan: "FREE" })).toEqual({ message: "m", plan: "FREE" });
    expect(planLimitFrom({ code: "PLAN_LIMIT", error: "m" })).toEqual({ message: "m", plan: null });
    expect(planLimitFrom({ error: "Validation failed" })).toBeNull();
    expect(planLimitFrom(null)).toBeNull();
  });
});

describe("every plan-limit surface uses the shared notice", () => {
  const B = "src/app/admin/o/[organizationSlug]";
  it("the six named components + the real Telegram connect section + the new-group page", () => {
    for (const f of [
      `${B}/groups/new/AddGroupForm.tsx`,
      `${B}/g/[groupSlug]/players/PlayersRoster.tsx`,
      `${B}/g/[groupSlug]/CanonicalPlayersSection.tsx`,
      `${B}/g/[groupSlug]/matches/CreateMatchForm.tsx`,
      `${B}/g/[groupSlug]/matches/SchedulesSection.tsx`,
      `${B}/g/[groupSlug]/matches/[matchId]/PostGameSection.tsx`,
      `${B}/g/[groupSlug]/CanonicalTelegramSection.tsx`,
      `${B}/g/[groupSlug]/CommunicationChannelsSection.tsx`,
    ]) {
      const src = read(f);
      expect(src, f).toContain('from "@/components/billing/PlanLimitNotice"');
      expect(src, f).toContain("<PlanLimitNotice");
    }
    const newGroup = read(`${B}/groups/new/page.tsx`);
    expect(newGroup).toContain('planLimitMessage(plan, "activeGroups")'); // proactive: shown instead of the form at the limit
    const layout = read(`${B}/layout.tsx`);
    expect(layout).toContain("upgradeHref: isOwner && billingEnabled ? billingPagePath(org.slug) : null");
  });
});

describe("Telegram action-level restrictions (match page + Game Day Update settings)", () => {
  const TG = "Telegram integration is available with Pro. This organization is on the Free plan; players can answer through the match link. Upgrade to Pro to connect Telegram.";
  const owner: PlanLimitViewer = { upgradeHref: "/admin/o/club/billing", isOwner: true, billingEnabled: true, plan: "FREE", supportEmail: "support@teambalancepro.com" };
  const gameDay = (viewer: PlanLimitViewer) =>
    renderToStaticMarkup(
      createElement(
        PlanLimitProvider,
        { value: viewer } as Parameters<typeof PlanLimitProvider>[0],
        createElement(GameDayUpdateSection, { organizationSlug: "club", groupSlug: "g", initial: { settings: GAME_DAY_UPDATE_DEFAULTS, telegramAvailable: false, planMessage: TG } })
      )
    );
  it("Game Day Update on a Free plan: OWNER gets Upgrade to Pro → this organization's Billing; ADMIN is told to ask the owner", () => {
    const o = gameDay(owner);
    expect(o).toContain("Telegram integration is available with Pro.");
    expect(o).toMatch(/<a href="\/admin\/o\/club\/billing"[^>]*>Upgrade to Pro/);
    const a = gameDay({ ...owner, isOwner: false, upgradeHref: null });
    expect(a).toContain("Ask your organization owner to upgrade to Pro.");
    expect(a).not.toContain("/billing");
  });
  it("a Telegram restriction on a non-Free plan never offers an upgrade", () => {
    for (const plan of ["PRO", "TRIAL", "COMP", "LEGACY"]) {
      const html = gameDay({ ...owner, plan });
      expect(html, plan).not.toContain("/billing"); // no upgrade link (the server's own wording is shown as-is)
      expect(html, plan).not.toContain("Ask your organization owner");
    }
  });
  it("the match page routes every Telegram action's reply through the plan-limit check; other errors keep the existing message", () => {
    const src = read("src/app/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/MatchWorkspace.tsx");
    expect(src).toContain('from "@/components/billing/PlanLimitNotice"');
    expect(src).toContain("<PlanLimitNotice message={limit.message} plan={limit.plan} />");
    // call() (poll, sync, Telegram chat, post-game start_mvp/post_message, automation), scope, close-and-post,
    // close poll, close notice and mark-sent: each checks for a PLAN_LIMIT first, then falls back to the old message.
    expect(src.match(/planLimitShown\(res, data\)/g)).toHaveLength(6);
    expect(src).toContain("const planLimit = res.ok ? null : planLimitFrom(data);");
    expect(src).toContain('else setMessage(data?.message ?? data?.error ?? "Something went wrong.");');
    expect(src.match(/setLimit\(null\);/g)!.length).toBeGreaterThanOrEqual(9); // a new action clears an old notice
  });
});

describe("pricing: player limits are per organization, across all groups", () => {
  it("cards and comparison table", () => {
    expect(planFeatures(PLAN_LIMITS.FREE, { upTo: false })[1].text).toBe("Up to 30 players per organization, across all groups");
    expect(planFeatures(PLAN_LIMITS.PRO, { upTo: true })[1].text).toBe("Up to 150 players per organization, across all groups");
    expect(renderToStaticMarkup(createElement(PlanComparison))).toContain("Active players (per organization, across all groups)");
  });
});
