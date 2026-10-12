-- Phase 4B (step 1) — attendance deadline, venue weather location, Game Day Update event.
-- Additive only: one enum value, one nullable Match column (+ index), six Venue
-- columns (nullable, or NOT NULL with a constant default). No column, table or
-- row is removed; no existing value is changed except the one-time backfill of
-- the NEW column below.
--
-- Backfill: every existing RECURRING Match (it has a MatchAutomation row) gets
-- attendanceDeadlineAt = its automation cutoff (MatchAutomation.cutoffDueAt), the
-- deadline the automation already enforces — EXCEPT a Match an organizer
-- intentionally reopened after its cutoff (attendanceClosedAt IS NULL while
-- cutoffCompletedAt IS NOT NULL): it keeps NULL (no deadline), so it stays open.
-- Manual Matches (no MatchAutomation row) keep NULL (no deadline, unchanged).
-- Only the new column is written ("updatedAt" is not touched). Idempotent.
--
-- Rollback (after reverting the code that uses these columns):
--   DROP INDEX IF EXISTS "Match_attendanceDeadlineAt_idx";
--   ALTER TABLE "Match" DROP COLUMN "attendanceDeadlineAt";
--   ALTER TABLE "Venue" DROP COLUMN "isIndoor", DROP COLUMN "weatherLatitude", DROP COLUMN "weatherLongitude",
--     DROP COLUMN "weatherLocationLabel", DROP COLUMN "weatherLocationConfirmedAt", DROP COLUMN "weatherLocationConfirmedByUserId";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261019120000_phase4b_attendance_deadline_weather';
-- PostgreSQL cannot drop an enum value: 'GAME_DAY_UPDATE_POSTED' stays in
-- "MessageEventType" (harmless while unused; removing it would need a type rebuild).

-- AlterEnum (IF NOT EXISTS: the value survives a rollback, so re-applying stays possible)
ALTER TYPE "MessageEventType" ADD VALUE IF NOT EXISTS 'GAME_DAY_UPDATE_POSTED';

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "attendanceDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "isIndoor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "weatherLatitude" DOUBLE PRECISION,
ADD COLUMN     "weatherLocationConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "weatherLocationConfirmedByUserId" TEXT,
ADD COLUMN     "weatherLocationLabel" TEXT,
ADD COLUMN     "weatherLongitude" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Match_attendanceDeadlineAt_idx" ON "Match"("attendanceDeadlineAt");


-- Backfill (see header): recurring Matches get their automation cutoff as the deadline,
-- except ones reopened after the cutoff.
UPDATE "Match" AS m
SET "attendanceDeadlineAt" = a."cutoffDueAt"
FROM "MatchAutomation" AS a
WHERE a."matchId" = m."id"
  AND m."attendanceDeadlineAt" IS NULL
  AND NOT (m."attendanceClosedAt" IS NULL AND a."cutoffCompletedAt" IS NOT NULL);
