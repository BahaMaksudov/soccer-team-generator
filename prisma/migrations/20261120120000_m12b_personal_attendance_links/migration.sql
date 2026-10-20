-- M12B — personal attendance links (website-only matches) and a new attendance
-- source value. Additive only: one enum value and one new empty table (indexes,
-- foreign keys). No existing table, column or row is changed; existing
-- attendance (incl. historical LINK answers), polls and matches are untouched.
--
-- Rollback (after reverting the code that uses it):
--   DROP TABLE "PersonalAttendanceLink";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120120000_m12b_personal_attendance_links';
-- PostgreSQL cannot drop an enum value: 'PERSONAL_LINK' stays in "AttendanceSource"
-- (harmless while unused). IF NOT EXISTS keeps a re-apply safe.

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE IF NOT EXISTS 'PERSONAL_LINK';

-- CreateTable
CREATE TABLE "PersonalAttendanceLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "windowStartedAt" TIMESTAMP(3),
    "windowCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PersonalAttendanceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAttendanceLink_tokenHash_key" ON "PersonalAttendanceLink"("tokenHash");

-- CreateIndex
CREATE INDEX "PersonalAttendanceLink_matchId_playerId_idx" ON "PersonalAttendanceLink"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "PersonalAttendanceLink_groupId_idx" ON "PersonalAttendanceLink"("groupId");

-- AddForeignKey
ALTER TABLE "PersonalAttendanceLink" ADD CONSTRAINT "PersonalAttendanceLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalAttendanceLink" ADD CONSTRAINT "PersonalAttendanceLink_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalAttendanceLink" ADD CONSTRAINT "PersonalAttendanceLink_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

