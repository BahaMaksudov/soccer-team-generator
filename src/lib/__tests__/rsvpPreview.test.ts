import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { maskEmail } from "@/lib/rsvpPreview";
import { PLAN_LIMITS, utcDay, utcMonth } from "@/lib/entitlements";

/** M13B P2 — masking, UTC allowance windows, plan allowances, and an inert Send button. */
describe("maskEmail", () => {
  it("keeps the first character and the domain only", () => {
    expect(maskEmail("pat.smith+soccer@example.com")).toBe("p•••@example.com");
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
    expect(maskEmail("broken")).toBe("•••");
    expect(maskEmail("pat.smith@example.com")).not.toContain("pat.smith");
  });
});

describe("UTC allowance windows", () => {
  it("day: [00:00Z, next 00:00Z) regardless of local time", () => {
    expect(utcDay(new Date("2026-10-21T23:59:59.999Z"))).toMatchObject({ period: "2026-10-21", start: new Date("2026-10-21T00:00:00Z"), next: new Date("2026-10-22T00:00:00Z") });
    expect(utcDay(new Date("2026-10-22T00:00:00Z")).period).toBe("2026-10-22");
    expect(utcDay(new Date("2026-12-31T12:00:00Z")).next).toEqual(new Date("2027-01-01T00:00:00Z"));
  });
  it("month: calendar month in UTC, including year and leap boundaries", () => {
    expect(utcMonth(new Date("2026-10-31T23:59:59Z"))).toMatchObject({ period: "2026-10", next: new Date("2026-11-01T00:00:00Z") });
    expect(utcMonth(new Date("2026-12-15T00:00:00Z")).next).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(utcMonth(new Date("2028-02-29T10:00:00Z"))).toMatchObject({ period: "2028-02", next: new Date("2028-03-01T00:00:00Z") });
  });
});

describe("owner-approved RSVP allowances in the plan catalog", () => {
  it("Free and Trial 100 / 20; Pro, complimentary and LEGACY 500 / 50", () => {
    for (const p of ["FREE", "TRIAL"] as const) expect([PLAN_LIMITS[p].rsvpEmailsPerMonth, PLAN_LIMITS[p].rsvpEmailsPerDay], p).toEqual([100, 20]);
    for (const p of ["PRO", "COMP", "LEGACY"] as const) expect([PLAN_LIMITS[p].rsvpEmailsPerMonth, PLAN_LIMITS[p].rsvpEmailsPerDay], p).toEqual([500, 50]);
  });
});

describe("the preview stays read-only (P5 sending lives elsewhere)", () => {
  const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/o/[organizationSlug]/g/[groupSlug]/matches/[matchId]/rsvp-preview/route.ts"), "utf8");
  it("the preview route exports GET only and imports nothing that sends", () => {
    expect(route).toContain("export async function GET");
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    const lib = fs.readFileSync(path.join(process.cwd(), "src/lib/rsvpPreview.ts"), "utf8");
    // No email-sending module (@/lib/email or @/lib/email/*), no Telegram, no tokens, no writes.
    expect(lib).not.toMatch(/@\/lib\/email["/]|@\/lib\/rsvpSend|telegram\(|callTelegram|generateToken|issueUnsubscribeToken|confirmUnsubscribe|\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete|\$executeRaw/);
  });
});
