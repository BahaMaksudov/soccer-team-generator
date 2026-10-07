-- M9.2-6/7 — weekly Match schedules and per-Match automation state.
-- Additive: two tables, one nullable column (Match.scheduleId), indexes, FKs and
-- CHECK constraints. No backfill (no schedules exist yet).
-- (Match.scheduleId, Match.date) is UNIQUE: a schedule creates at most one Match per
-- game date, the idempotency key of automatic creation (NULL scheduleIds don't collide).

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "MatchSchedule" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "venueId" TEXT,
    "timezone" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "pollDaysBefore" INTEGER NOT NULL,
    "pollTime" TEXT NOT NULL,
    "cutoffDaysBefore" INTEGER NOT NULL,
    "cutoffTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAutomation" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "pollDueAt" TIMESTAMP(3) NOT NULL,
    "cutoffDueAt" TIMESTAMP(3) NOT NULL,
    "pollPostedAt" TIMESTAMP(3),
    "cutoffCompletedAt" TIMESTAMP(3),
    "notifyClaimedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchSchedule_groupId_idx" ON "MatchSchedule"("groupId");

-- CreateIndex
CREATE INDEX "MatchSchedule_isActive_idx" ON "MatchSchedule"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAutomation_matchId_key" ON "MatchAutomation"("matchId");

-- CreateIndex
CREATE INDEX "MatchAutomation_groupId_idx" ON "MatchAutomation"("groupId");

-- CreateIndex
CREATE INDEX "MatchAutomation_cutoffDueAt_idx" ON "MatchAutomation"("cutoffDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Match_scheduleId_date_key" ON "Match"("scheduleId", "date");

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MatchSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAutomation" ADD CONSTRAINT "MatchAutomation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAutomation" ADD CONSTRAINT "MatchAutomation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- Defense in depth: valid local wall-clock configuration only.
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_days_check" CHECK ("pollDaysBefore" BETWEEN 0 AND 6 AND "cutoffDaysBefore" BETWEEN 0 AND 6);
ALTER TABLE "MatchSchedule" ADD CONSTRAINT "MatchSchedule_times_check" CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "pollTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "cutoffTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
