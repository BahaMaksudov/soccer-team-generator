-- M9-D enhancement — Player of the Match determination method (migration #21).
--
-- Additive only: one new enum and four NULLABLE MatchMvp columns (+ an audit
-- FK to User, SET NULL). No row is created, updated or deleted; existing
-- MatchMvp rows keep method = NULL (the application derives PLAYER_VOTE for
-- a started vote). Pre-checked on Production (read-only): 0 MatchMvp rows.

-- CreateEnum
CREATE TYPE "MvpMethod" AS ENUM ('PLAYER_VOTE', 'ORGANIZER_SELECTION');

-- AlterTable
ALTER TABLE "MatchMvp" ADD COLUMN     "method" "MvpMethod",
ADD COLUMN     "selectedAt" TIMESTAMP(3),
ADD COLUMN     "selectedByUserId" TEXT,
ADD COLUMN     "selectedPlayerId" TEXT;

-- AddForeignKey
ALTER TABLE "MatchMvp" ADD CONSTRAINT "MatchMvp_selectedByUserId_fkey" FOREIGN KEY ("selectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

