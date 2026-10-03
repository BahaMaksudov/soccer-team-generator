-- M9-B — Channel scope & Match identity (migration #19).
--
-- No data is rewritten: no UPDATE/DELETE/backfill. Existing rows keep their
-- values (Match.telegramChatId NULL, TelegramChat.disconnectedAt NULL).
--
-- 1. TeamGeneration identity: Match-linked rows are identified by "matchId"
--    (already UNIQUE since #18); the (groupId, date) uniqueness now applies
--    ONLY to legacy rows without a Match (partial unique index — Prisma cannot
--    express it, see schema.prisma). Two Matches on the same day can each
--    keep their own teams.
-- 2. TelegramChat soft disconnect: "disconnectedAt"; a chat may be ACTIVE in
--    at most one Group (partial unique on chatId WHERE disconnectedAt IS NULL)
--    and has at most one row per Group (unique (chatId, groupId)).
-- 3. TelegramChatPlayer: organizer-curated default player scope of a chat.
--    Composite FKs make cross-Group rows impossible.
-- 4. Match.telegramChatId: selected chat (context only, not proof of a send).
--
-- The new partial unique indexes are created (after the columns they use)
-- BEFORE the old full unique indexes are dropped, so uniqueness is never unenforced. Pre-checked on
-- Production (read-only): 0 duplicate legacy (groupId, date), 0 duplicate
-- chatIds — the new indexes cannot fail.

-- CreateEnum
CREATE TYPE "TelegramChatPlayerSource" AS ENUM ('ORGANIZER', 'SUGGESTED_VOTE');

-- AlterTable
ALTER TABLE "TelegramChat" ADD COLUMN     "disconnectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "telegramChatId" INTEGER;

-- CreateTable
CREATE TABLE "TelegramChatPlayer" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "telegramChatId" INTEGER NOT NULL,
    "playerId" TEXT NOT NULL,
    "source" "TelegramChatPlayerSource" NOT NULL DEFAULT 'ORGANIZER',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramChatPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramChatPlayer_groupId_idx" ON "TelegramChatPlayer"("groupId");

-- CreateIndex
CREATE INDEX "TelegramChatPlayer_playerId_idx" ON "TelegramChatPlayer"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChatPlayer_telegramChatId_playerId_key" ON "TelegramChatPlayer"("telegramChatId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_id_groupId_key" ON "Player"("id", "groupId");

-- CreateIndex
CREATE INDEX "TeamGeneration_groupId_date_idx" ON "TeamGeneration"("groupId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChat_chatId_groupId_key" ON "TelegramChat"("chatId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChat_id_groupId_key" ON "TelegramChat"("id", "groupId");

-- CreateIndex
CREATE INDEX "Match_telegramChatId_idx" ON "Match"("telegramChatId");

-- AddForeignKey
ALTER TABLE "TelegramChatPlayer" ADD CONSTRAINT "TelegramChatPlayer_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChatPlayer" ADD CONSTRAINT "TelegramChatPlayer_telegramChatId_groupId_fkey" FOREIGN KEY ("telegramChatId", "groupId") REFERENCES "TelegramChat"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChatPlayer" ADD CONSTRAINT "TelegramChatPlayer_playerId_groupId_fkey" FOREIGN KEY ("playerId", "groupId") REFERENCES "Player"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChatPlayer" ADD CONSTRAINT "TelegramChatPlayer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_telegramChatId_fkey" FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex (raw SQL: partial unique, legacy generations only)
CREATE UNIQUE INDEX "TeamGeneration_groupId_date_legacy_key" ON "TeamGeneration"("groupId", "date") WHERE "matchId" IS NULL;

-- CreateIndex (raw SQL: partial unique, a chat is active in at most one Group)
CREATE UNIQUE INDEX "TelegramChat_chatId_active_key" ON "TelegramChat"("chatId") WHERE "disconnectedAt" IS NULL;

-- DropIndex (replaced by "TeamGeneration_groupId_date_legacy_key")
DROP INDEX "TeamGeneration_groupId_date_key";

-- DropIndex (replaced by "TelegramChat_chatId_active_key" + "TelegramChat_chatId_groupId_key")
DROP INDEX "TelegramChat_chatId_key";
