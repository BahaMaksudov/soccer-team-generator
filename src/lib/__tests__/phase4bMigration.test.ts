import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** Phase 4B step 1 — the migration is strictly additive; the only row write is the guarded backfill of the NEW column. */
const DIR = "prisma/migrations/20261019120000_phase4b_attendance_deadline_weather";
const sql = fs.readFileSync(path.join(process.cwd(), DIR, "migration.sql"), "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only (comments removed)

describe("Phase 4B step 1 migration", () => {
  it("is the newest migration and sorts after Phase 2's", () => {
    const all = fs.readdirSync(path.join(process.cwd(), "prisma/migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(all.at(-1)).toBe(path.basename(DIR));
    expect(all.at(-2)).toBe("20261018120000_phase2_match_schedule_skips");
  });
  it("adds only: one enum value (idempotent), one Match column + index, six Venue columns", () => {
    expect(code).toMatch(/ALTER TYPE "MessageEventType" ADD VALUE IF NOT EXISTS 'GAME_DAY_UPDATE_POSTED';/);
    expect(code).toMatch(/ALTER TABLE "Match" ADD COLUMN\s+"attendanceDeadlineAt" TIMESTAMP\(3\);/);
    expect(code).toMatch(/CREATE INDEX "Match_attendanceDeadlineAt_idx" ON "Match"\("attendanceDeadlineAt"\);/);
    for (const c of ['"isIndoor" BOOLEAN NOT NULL DEFAULT false', '"weatherLatitude" DOUBLE PRECISION', '"weatherLongitude" DOUBLE PRECISION', '"weatherLocationLabel" TEXT', '"weatherLocationConfirmedAt" TIMESTAMP(3)', '"weatherLocationConfirmedByUserId" TEXT'])
      expect(code, c).toContain(c);
  });
  it("is non-destructive: no DROP / DELETE / TRUNCATE / RENAME / ALTER COLUMN / SET NOT NULL", () => {
    expect(code).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL/i);
    for (const m of code.matchAll(/ALTER TABLE "(\w+)"([^;]*);/g)) expect(m[2].trim(), m[1]).toMatch(/^ADD COLUMN/);
  });
  it("the only row write is the backfill of the new column, guarded for reopened matches and idempotent", () => {
    const updates = [...code.matchAll(/UPDATE\s+"(\w+)"[\s\S]*?;/g)];
    expect(updates.map((u) => u[1])).toEqual(["Match"]);
    const u = updates[0][0];
    expect(u).toMatch(/SET "attendanceDeadlineAt" = a\."cutoffDueAt"\s/);
    expect(u).not.toMatch(/"updatedAt"|"attendanceClosedAt"\s*=/); // writes nothing else
    expect(u).toContain('m."attendanceDeadlineAt" IS NULL');
    expect(u).toContain('NOT (m."attendanceClosedAt" IS NULL AND a."cutoffCompletedAt" IS NOT NULL)');
    expect(code).not.toMatch(/\bINSERT\b/i);
  });
  it("documents the rollback (incl. the enum limitation)", () => {
    expect(sql).toContain('DROP COLUMN "attendanceDeadlineAt"');
    expect(sql).toContain("PostgreSQL cannot drop an enum value");
  });
});
