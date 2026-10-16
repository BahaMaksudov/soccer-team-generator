import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { effectivePlan, telegramNotInPlanMessage, trialStatus, supportEmail, upgradeHint } from "@/lib/entitlements";
import { trialLifecycleMode, trialNoticeStage, EXPIRED_NOTICE_WINDOW_MS } from "@/lib/trialLifecycle";
import { trialBannerView } from "@/lib/trialBanner";
import { buildGoogleOnlyResetEmail, buildPasswordResetEmail, buildTrialEmail } from "@/lib/email/templates";
import { createResendTransport } from "@/lib/email/transport";
import { sessionIssuedBeforeReset, sessionsCutoff } from "@/lib/passwordReset";

/** M11.3 — pure pieces: trial boundaries, stages, texts, banner, emails, session cutoff, wiring. */
const DAY = 86_400_000;
const END = new Date("2027-01-31T10:30:00.000Z");
const at = (ms: number) => new Date(END.getTime() + ms);
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("trial boundary (UTC instants, evaluated per request)", () => {
  const org = { plan: "FREE" as const, trialEndsAt: END };
  it("trial until the last millisecond; Free from the exact end instant", () => {
    expect(effectivePlan(org, at(-89 * DAY))).toBe("TRIAL");
    expect(effectivePlan(org, at(-1))).toBe("TRIAL");
    expect(effectivePlan(org, END)).toBe("FREE");
    expect(effectivePlan(org, at(1))).toBe("FREE");
  });
  it("phases: active > 14 days, ending ≤ 14 days, expired at the end; LEGACY / COMP / PRO / no trial → none", () => {
    expect(trialStatus(org, at(-15 * DAY))).toMatchObject({ phase: "active", daysLeft: 15 });
    expect(trialStatus(org, at(-14 * DAY))).toMatchObject({ phase: "ending", daysLeft: 14 });
    expect(trialStatus(org, at(-1))).toMatchObject({ phase: "ending", daysLeft: 1 });
    expect(trialStatus(org, END)).toMatchObject({ phase: "expired", daysLeft: null, endsAt: END });
    for (const plan of ["LEGACY", "COMP", "PRO"] as const) expect(trialStatus({ plan, trialEndsAt: END }, at(-DAY)).phase).toBe("none");
    expect(trialStatus({ plan: "FREE", trialEndsAt: null }).phase).toBe("none");
  });
});

describe("reminder stages", () => {
  it("14 / 7 / 3 / 1 days, the nearest threshold reached; nothing before 14 days", () => {
    expect(trialNoticeStage(END, at(-14 * DAY - 1))).toBeNull();
    expect(trialNoticeStage(END, at(-14 * DAY))).toBe("D14");
    expect(trialNoticeStage(END, at(-8 * DAY))).toBe("D14");
    expect(trialNoticeStage(END, at(-7 * DAY))).toBe("D7");
    expect(trialNoticeStage(END, at(-4 * DAY))).toBe("D7");
    expect(trialNoticeStage(END, at(-3 * DAY))).toBe("D3");
    expect(trialNoticeStage(END, at(-DAY))).toBe("D1");
    expect(trialNoticeStage(END, at(-1))).toBe("D1");
  });
  it("EXPIRED from the end instant, within 7 days only", () => {
    expect(trialNoticeStage(END, END)).toBe("EXPIRED");
    expect(trialNoticeStage(END, at(EXPIRED_NOTICE_WINDOW_MS))).toBe("EXPIRED");
    expect(trialNoticeStage(END, at(EXPIRED_NOTICE_WINDOW_MS + 1))).toBeNull();
  });
  it("mode: OFF unless explicitly 'audit' or 'send'", () => {
    expect(trialLifecycleMode({})).toBe("off");
    expect(trialLifecycleMode({ TRIAL_LIFECYCLE: "yes" })).toBe("off");
    expect(trialLifecycleMode({ TRIAL_LIFECYCLE: " Audit " })).toBe("audit");
    expect(trialLifecycleMode({ TRIAL_LIFECYCLE: "send" })).toBe("send");
  });
});

describe("Telegram 'not in plan' message — understandable, honest about billing", () => {
  it("after the trial: when it ended, what still works, nothing deleted, coming soon (billing off)", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect(telegramNotInPlanMessage({ plan: "FREE", trialEndsAt: END }, at(DAY), {})).toBe(
      "Telegram integration is part of Pro. This organization's Pro trial ended on Jan 31, 2027, so it is now on the Free plan. Players can still answer through the match link, and existing polls, messages and connected Telegram groups are kept. Pro plans and upgrades are coming soon."
    );
    expect(telegramNotInPlanMessage({ plan: "FREE", trialEndsAt: null }, END, {})).toBe(
      "Telegram integration is part of Pro. This organization is on the Free plan; players can answer through the match link. Pro plans and upgrades are coming soon."
    );
  });
  it("support contact only when SUPPORT_EMAIL is a valid address", () => {
    vi.stubEnv("BILLING_ENABLED", "");
    expect(supportEmail({ SUPPORT_EMAIL: "help@teambalancepro.com" })).toBe("help@teambalancepro.com");
    expect(supportEmail({ SUPPORT_EMAIL: "not an address" })).toBeNull();
    expect(supportEmail({ SUPPORT_EMAIL: "<x@y.z>" })).toBeNull();
    expect(upgradeHint({ SUPPORT_EMAIL: "help@teambalancepro.com" })).toBe("Pro plans and upgrades are coming soon. Questions? Contact help@teambalancepro.com.");
  });
});

describe("trial banner", () => {
  const org = { slug: "club", plan: "FREE" as const, trialEndsAt: END };
  it("OWNER/ADMIN only; ending (≤ 14 days) and expired (≤ 30 days after); never for MEMBER, LEGACY, COMP or long-expired", () => {
    expect(trialBannerView(org, "MEMBER", at(-DAY), false)).toBeNull();
    expect(trialBannerView(org, "OWNER", at(-15 * DAY), false)).toBeNull();
    expect(trialBannerView(org, "OWNER", at(-3 * DAY), false)).toMatchObject({ phase: "ending", title: "Your Pro trial ends in 3 days (Jan 31, 2027).", upgradeHref: null, hint: "Pro plans and upgrades are coming soon." });
    expect(trialBannerView(org, "ADMIN", at(-1), false)?.title).toBe("Your Pro trial ends in less than a day (Jan 31, 2027).");
    expect(trialBannerView(org, "OWNER", at(DAY), false)).toMatchObject({ phase: "expired", title: "Your Pro trial ended on Jan 31, 2027. This organization is on the Free plan." });
    expect(trialBannerView(org, "OWNER", at(DAY), false)!.body).toMatch(/Telegram polls.*off on Free.*kept/);
    expect(trialBannerView(org, "OWNER", at(31 * DAY), false)).toBeNull();
    for (const plan of ["LEGACY", "COMP", "PRO"] as const) expect(trialBannerView({ ...org, plan }, "OWNER", at(-DAY), false)).toBeNull();
  });
  it("Upgrade action only with billing enabled, and only for the OWNER (ADMIN gets a pointer to the owner)", () => {
    expect(trialBannerView(org, "OWNER", at(-DAY), true)).toMatchObject({ upgradeHref: "/admin/o/club/billing", hint: null });
    expect(trialBannerView(org, "ADMIN", at(-DAY), true)).toMatchObject({ upgradeHref: null, hint: "The organization owner can upgrade to Pro on the Billing page." });
  });
});

describe("emails", () => {
  it("trial reminder / expiry: facts, nothing deleted, no payment link of its own", () => {
    const r = buildTrialEmail({ to: "o@x.test", organizationName: "Club", stage: "REMINDER", daysLeft: 7, endsOn: "Jan 31, 2027", upgradeLine: "Pro plans and upgrades are coming soon.", url: "https://tbp.test/admin/o/club" });
    expect(r.subject).toBe("Your Pro trial ends in 7 days — Club");
    expect(r.text).toMatch(/ends in 7 days \(Jan 31, 2027\)\. Afterwards the Free plan applies automatically; nothing is charged\./);
    expect(r.text).toMatch(/Nothing is deleted/);
    expect(r.html).not.toMatch(/stripe|checkout/i);
    const e = buildTrialEmail({ to: "o@x.test", organizationName: "Club <b>", stage: "EXPIRED", daysLeft: null, endsOn: "Jan 31, 2027", upgradeLine: "x", url: "https://tbp.test/admin/o/club" });
    expect(e.subject).toBe("Your Pro trial has ended — Club <b>");
    expect(e.html).toContain("Club &lt;b&gt;"); // escaped
    expect(buildTrialEmail({ to: "o@x.test", organizationName: "C", stage: "REMINDER", daysLeft: 1, endsOn: "d", upgradeLine: "x", url: "https://t/x" }).subject).toBe("Your Pro trial ends within a day — C");
  });
  it("password reset: the link, its expiry and single use; Google-only: no reset link at all", () => {
    const m = buildPasswordResetEmail({ to: "a@x.test", name: "A", url: "https://tbp.test/reset-password/tok", expiresAt: new Date("2027-01-01T12:00:00Z") });
    expect(m.text).toContain("https://tbp.test/reset-password/tok");
    expect(m.text).toMatch(/60 minutes.*used once.*signs you out everywhere else/);
    const g = buildGoogleOnlyResetEmail({ to: "a@x.test", name: null, url: "https://tbp.test/login" });
    expect(g.text).not.toMatch(/reset-password/);
    expect(g.text).toMatch(/Continue with Google/);
  });
  it("Resend: the idempotency key travels as the Idempotency-Key header (only when given)", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_u: unknown, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { ok: true, status: 200, json: async () => ({ id: "re_1" }) };
    }) as unknown as typeof fetch;
    const t = createResendTransport({ apiKey: "re_test", fetchImpl });
    vi.spyOn(console, "info").mockImplementation(() => {});
    await t.send({ to: "a@x.test", from: "f@x.test", subject: "s", text: "t", html: "h", idempotencyKey: "trial-notice/abc" });
    await t.send({ to: "a@x.test", from: "f@x.test", subject: "s", text: "t", html: "h" });
    expect(seen[0]["Idempotency-Key"]).toBe("trial-notice/abc");
    expect(seen[1]).not.toHaveProperty("Idempotency-Key");
  });
});

describe("session cutoff after a password reset", () => {
  it("every token issued up to and including the reset's second is void; later ones are valid; no reset → valid", () => {
    const now = new Date("2027-01-01T12:00:00.400Z");
    const cutoff = sessionsCutoff(now);
    expect(cutoff.toISOString()).toBe("2027-01-01T12:00:01.000Z");
    const s = Math.floor(now.getTime() / 1000);
    expect(sessionIssuedBeforeReset(s - 100, cutoff)).toBe(true);
    expect(sessionIssuedBeforeReset(s, cutoff)).toBe(true);
    expect(sessionIssuedBeforeReset(s + 1, cutoff)).toBe(false);
    expect(sessionIssuedBeforeReset(undefined, cutoff)).toBe(true);
    expect(sessionIssuedBeforeReset(s - 100, null)).toBe(false);
  });
});

describe("wiring (source checks)", () => {
  it("organizer poll close and closure-notice retry check the Telegram plan after the role check; mark_sent does not send", () => {
    const close = read("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close/route.ts");
    expect(close.indexOf("telegramDenied(context.organization.id)")).toBeGreaterThan(close.indexOf("managersOnlyResponse(context)"));
    expect(close.indexOf("telegramDenied(context.organization.id)")).toBeLessThan(close.indexOf("closeMatchAttendancePolls(context"));
    const notice = read("src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/poll/close-notice/route.ts");
    expect(notice).toMatch(/if \(parsed\.data\.action === "retry"\) \{\s*const notInPlan = await telegramDenied/);
  });
  it("a connect code is checked against the plan before any Telegram call or write", () => {
    const src = read("src/lib/telegramChannels.ts");
    const fn = src.slice(src.indexOf("export async function redeemTelegramBindCode"));
    expect(fn.indexOf('code: "NOT_IN_PLAN"')).toBeGreaterThan(0);
    expect(fn.indexOf('code: "NOT_IN_PLAN"')).toBeLessThan(fn.indexOf('callTelegram("getChatAdministrators"'));
  });
  it("the trial job runs from the existing automation clock, OFF unless TRIAL_LIFECYCLE is set; no new workflow / schedule", () => {
    expect(read("src/app/api/cron/automation/route.ts")).toContain("runTrialLifecycle(now)");
    const workflows = fs.readdirSync(path.join(process.cwd(), ".github/workflows"));
    expect(workflows.filter((f) => /trial/i.test(f))).toEqual([]);
    expect(read(".github/workflows/match-automation.yml")).toContain('cron: "*/15 * * * *"');
  });
  it("migrations are additive only (no DROP / DELETE / UPDATE / ALTER COLUMN on existing data)", () => {
    for (const dir of ["20261101120000_m11_3_trial_notices", "20261101120100_m11_3_password_reset"]) {
      const sql = read(`prisma/migrations/${dir}/migration.sql`).replace(/--.*$/gm, "");
      // Statement level (the new foreign keys' "ON DELETE / ON UPDATE CASCADE" clauses are not data changes).
      expect(sql, dir).not.toMatch(/^\s*(DROP|DELETE|UPDATE|TRUNCATE|INSERT)\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL|DROP COLUMN/im);
      expect(sql.match(/^\s*[A-Z]+ [A-Z]+/gm)!.map((s) => s.trim()).every((s) => ["CREATE TYPE", "CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE", "ALTER TABLE"].includes(s)), dir).toBe(true);
    }
    expect(read("prisma/migrations/20261101120100_m11_3_password_reset/migration.sql")).toMatch(/ALTER TABLE "User" ADD COLUMN\s+"sessionsValidAfter" TIMESTAMP\(3\);/);
  });
  it("new public pages are redesigned + ungated; the forgot route answers generically", () => {
    expect(read("src/middleware.ts")).toContain('"/forgot-password", "/reset-password/:path*"');
    const forgot = read("src/app/api/password/forgot/route.ts");
    expect(forgot).toContain("after(");
    expect(forgot.match(/NextResponse\.json\(\{ ok: true, message: FORGOT_PASSWORD_MESSAGE \}\)/g)).toHaveLength(1);
  });
});
