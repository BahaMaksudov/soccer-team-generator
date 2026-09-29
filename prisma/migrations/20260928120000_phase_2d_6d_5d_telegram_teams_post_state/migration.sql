-- Phase 2D.6D.5D — canonical Close Poll + Post Teams idempotency state.
-- Purely additive: one new enum, four nullable columns. No default,
-- no NOT NULL, no index, and deliberately NO backfill — historical
-- TelegramPoll rows stay NULL, meaning "no canonical durable posting
-- record" (not "never posted").

-- CreateEnum
CREATE TYPE "TelegramTeamsPostStatus" AS ENUM ('SENDING', 'POSTED');

-- AlterTable
ALTER TABLE "TelegramPoll" ADD COLUMN     "postedTeamGenerationId" TEXT,
ADD COLUMN     "teamsPostClaimedAt" TIMESTAMP(3),
ADD COLUMN     "teamsPostStatus" "TelegramTeamsPostStatus",
ADD COLUMN     "teamsPostedAt" TIMESTAMP(3);
