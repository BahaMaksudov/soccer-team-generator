/**
 * Phase 4B step 1 — schema + backfill on the REAL (guarded, local) test
 * database, which the integration setup migrated to the latest migration. The
 * backfill statement is read from the migration file itself and run against
 * seeded attendance situations.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261019120000_phase4b_attendance_deadline_weather/migration.sql"), "utf8");
const BACKFILL = /UPDATE "Match" AS m[\s\S]*?;/.exec(sql.replace(/--.*$/gm, ""))![0];
const T = (s: string) => new Date(`${s}:00Z`);

beforeAll(async () => {
  const guarded = process.env.ITEST_GUARDED_DATABASE_URL;
  if (!guarded || process.env.DATABASE_URL !== guarded) throw new Error("Integration setup did not run the database guard — aborting.");
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>("SELECT current_database() AS db");
  if (!/test/i.test(db)) throw new Error(`Connected to '${db}' — aborting.`);
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Organization","User" RESTART IDENTITY CASCADE`);
  await prisma.organization.create({ data: { id: "o", name: "O", slug: "o" } });
  await prisma.group.create({ data: { id: "g", organizationId: "o", name: "G", slug: "g", timezone: "America/New_York" } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 4B step 1 — schema", () => {
  it("Match.attendanceDeadlineAt: nullable timestamp, indexed; new Matches default to NULL", async () => {
    const [col] = await prisma.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'Match' AND column_name = 'attendanceDeadlineAt'`
    );
    expect(col).toEqual({ data_type: "timestamp without time zone", is_nullable: "YES", column_default: null });
    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`SELECT indexname FROM pg_indexes WHERE tablename = 'Match' AND indexname = 'Match_attendanceDeadlineAt_idx'`);
    expect(idx).toHaveLength(1);
    const m = await prisma.match.create({ data: { groupId: "g", date: new Date("2099-01-05") } });
    expect(m.attendanceDeadlineAt).toBeNull();
  });
  it("Venue weather columns: isIndoor NOT NULL DEFAULT false; coordinates / label / confirmation nullable", async () => {
    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'Venue' AND (column_name = 'isIndoor' OR column_name LIKE 'weather%') ORDER BY column_name`
    );
    expect(cols).toEqual([
      { column_name: "isIndoor", data_type: "boolean", is_nullable: "NO", column_default: "false" },
      { column_name: "weatherLatitude", data_type: "double precision", is_nullable: "YES", column_default: null },
      { column_name: "weatherLocationConfirmedAt", data_type: "timestamp without time zone", is_nullable: "YES", column_default: null },
      { column_name: "weatherLocationConfirmedByUserId", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "weatherLocationLabel", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "weatherLongitude", data_type: "double precision", is_nullable: "YES", column_default: null },
    ]);
    const v = await prisma.venue.create({ data: { organizationId: "o", name: "ForeKicks", address: "1 Main St" } });
    expect(v).toMatchObject({ isIndoor: false, weatherLatitude: null, weatherLongitude: null, weatherLocationLabel: null, weatherLocationConfirmedAt: null, weatherLocationConfirmedByUserId: null });
  });
  it("MessageEventType has GAME_DAY_UPDATE_POSTED (usable by MessageDelivery)", async () => {
    const labels = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(`SELECT enumlabel FROM pg_enum WHERE enumtypid = '"MessageEventType"'::regtype ORDER BY enumsortorder`);
    expect(labels.map((l) => l.enumlabel).slice(-2)).toEqual(["GAME_DAY_UPDATE_POSTED", "POLL_CLOSED_NOTICE"]); // + the later notice value
    const d = await prisma.messageDelivery.create({ data: { groupId: "g", eventType: "GAME_DAY_UPDATE_POSTED", channel: "TELEGRAM", destination: "-1", contentHash: "x", status: "SENDING", claimedAt: new Date() } });
    expect(d.eventType).toBe("GAME_DAY_UPDATE_POSTED");
  });
});

describe("Phase 4B step 1 — backfill of existing recurring Matches", () => {
  const UPDATED = T("2026-10-02T00:00");
  async function seed() {
    const match = (id: string, closedAt: string | null, status: "SCHEDULED" | "COMPLETED" | "CANCELED" = "SCHEDULED") =>
      prisma.match.create({ data: { id, groupId: "g", date: new Date("2026-10-26"), status, attendanceClosedAt: closedAt ? T(closedAt) : null, updatedAt: UPDATED } });
    const auto = (matchId: string, cutoff: string, completed: string | null) =>
      prisma.matchAutomation.create({ data: { matchId, groupId: "g", pollDueAt: T("2026-10-01T00:00"), cutoffDueAt: T(cutoff), cutoffCompletedAt: completed ? T(completed) : null } });
    await match("r-pending", null);
    await auto("r-pending", "2026-10-27T00:00", null);
    await match("r-finalized", "2026-10-19T00:05", "COMPLETED");
    await auto("r-finalized", "2026-10-19T00:00", "2026-10-19T00:05");
    await match("r-reopened", null); // closed by the cutoff step, then reopened by an organizer
    await auto("r-reopened", "2026-10-12T00:00", "2026-10-12T00:05");
    await match("r-closed-early", "2026-10-20T12:00"); // closed by hand before its cutoff
    await auto("r-closed-early", "2026-10-28T00:00", null);
    await match("r-canceled", null, "CANCELED");
    await auto("r-canceled", "2026-10-29T00:00", null);
    await match("r-missed-cutoff", null); // cutoff passed, automation never ran it
    await auto("r-missed-cutoff", "2026-10-05T00:00", null);
    await match("m-open", null); // manual: no MatchAutomation
    await match("m-closed", "2026-10-29T10:00");
    // Simulate "before the migration": the new column empty everywhere.
    await prisma.$executeRawUnsafe(`UPDATE "Match" SET "attendanceDeadlineAt" = NULL`);
  }
  const deadlines = async () =>
    Object.fromEntries((await prisma.match.findMany({ select: { id: true, attendanceDeadlineAt: true }, orderBy: { id: "asc" } })).map((m) => [m.id, m.attendanceDeadlineAt?.toISOString() ?? null]));

  it("recurring Matches get their automation cutoff; reopened-after-cutoff and manual Matches keep NULL", async () => {
    await seed();
    expect(await prisma.$executeRawUnsafe(BACKFILL)).toBe(5);
    expect(await deadlines()).toEqual({
      "m-closed": null,
      "m-open": null,
      "r-canceled": "2026-10-29T00:00:00.000Z",
      "r-closed-early": "2026-10-28T00:00:00.000Z",
      "r-finalized": "2026-10-19T00:00:00.000Z",
      "r-missed-cutoff": "2026-10-05T00:00:00.000Z",
      "r-pending": "2026-10-27T00:00:00.000Z",
      "r-reopened": null,
    });
  });

  it("writes only the new column (status, attendanceClosedAt, updatedAt and MatchAutomation unchanged) and is idempotent", async () => {
    await seed();
    const snap = async () => ({
      matches: (await prisma.match.findMany({ orderBy: { id: "asc" } })).map(({ attendanceDeadlineAt: _ignored, ...rest }) => rest),
      automations: await prisma.matchAutomation.findMany({ orderBy: { id: "asc" } }),
    });
    const before = await snap();
    await prisma.$executeRawUnsafe(BACKFILL);
    expect(await snap()).toEqual(before);
    expect((await prisma.match.findMany()).every((m) => m.updatedAt.getTime() === UPDATED.getTime())).toBe(true);
    expect(await prisma.$executeRawUnsafe(BACKFILL)).toBe(0); // second run: nothing to do
  });

  it("never overwrites a deadline that is already set", async () => {
    await seed();
    await prisma.match.update({ where: { id: "r-pending" }, data: { attendanceDeadlineAt: T("2026-10-26T20:00") } });
    await prisma.$executeRawUnsafe(BACKFILL);
    expect((await deadlines())["r-pending"]).toBe("2026-10-26T20:00:00.000Z");
  });
});
