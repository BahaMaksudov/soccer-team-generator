-- Phase 2 — persistent "recurring match skipped" warnings.
-- Additive only: one new table, its indexes and foreign keys. No existing
-- table, row or column is changed (no backfill). One row per (schedule, game
-- date) whose automatic Match was not created because the Organization's
-- monthly new-match allowance was reached.
--
-- Rollback (after reverting the code that uses it):
--   DROP TABLE "MatchScheduleSkip";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261018120000_phase2_match_schedule_skips';

-- CreateTable
CREATE TABLE "MatchScheduleSkip" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "occurrenceDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "monthlyLimit" INTEGER NOT NULL,
    "firstSkippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSkippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,

    CONSTRAINT "MatchScheduleSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchScheduleSkip_groupId_idx" ON "MatchScheduleSkip"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchScheduleSkip_scheduleId_occurrenceDate_key" ON "MatchScheduleSkip"("scheduleId", "occurrenceDate");

-- AddForeignKey
ALTER TABLE "MatchScheduleSkip" ADD CONSTRAINT "MatchScheduleSkip_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchScheduleSkip" ADD CONSTRAINT "MatchScheduleSkip_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MatchSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchScheduleSkip" ADD CONSTRAINT "MatchScheduleSkip_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

