-- Phase 2D.7 — require tenant ownership on every tenant-owned table.
--   1. groupId NOT NULL on Player, TeamGeneration, TelegramPoll,
--      TelegramPollAnswer, TelegramUserLink, TelegramChat.
--   2. The five Group foreign keys (same names) change from
--      ON DELETE SET NULL to ON DELETE RESTRICT (ON UPDATE CASCADE kept):
--      a Group can no longer be deleted while it still owns rows.
-- TelegramPollAnswer keeps its plain groupId column (no Group FK added).
-- Production read-only preflight found 0 NULL and 0 orphan groupId rows
-- in all six tables. Forward-only; no data is changed or removed.

-- All-or-nothing: if any statement fails, no foreign key is left dropped.
BEGIN;

-- DropForeignKey
ALTER TABLE "Player" DROP CONSTRAINT "Player_groupId_fkey";

-- DropForeignKey
ALTER TABLE "TeamGeneration" DROP CONSTRAINT "TeamGeneration_groupId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramPoll" DROP CONSTRAINT "TelegramPoll_groupId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramUserLink" DROP CONSTRAINT "TelegramUserLink_groupId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramChat" DROP CONSTRAINT "TelegramChat_groupId_fkey";

-- AlterTable
ALTER TABLE "Player" ALTER COLUMN "groupId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TeamGeneration" ALTER COLUMN "groupId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TelegramPoll" ALTER COLUMN "groupId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TelegramPollAnswer" ALTER COLUMN "groupId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TelegramUserLink" ALTER COLUMN "groupId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TelegramChat" ALTER COLUMN "groupId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamGeneration" ADD CONSTRAINT "TeamGeneration_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramPoll" ADD CONSTRAINT "TelegramPoll_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserLink" ADD CONSTRAINT "TelegramUserLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
