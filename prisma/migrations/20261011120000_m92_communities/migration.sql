-- M9.2-1 — provider-neutral Communities (rosters) of a Group.
-- Additive: two tables, two nullable columns, indexes and composite (same-Group) FKs.
--
-- Backfill uses ONLY existing authoritative relationships — never names, never votes:
--   * every existing TelegramChat binding becomes one Community of its Group
--     (name = chat title; inactive when the binding is disconnected) and is
--     attached to it as that Community's Telegram channel;
--   * Community memberships come ONLY from the organizer-curated M9-B chat
--     scope (TelegramChatPlayer: added by an OWNER/ADMIN, directly or by
--     accepting a linked-voter suggestion);
--   * a Match belongs to the Community of the Telegram chat that was selected
--     for it (Match.telegramChatId). Matches without a selected chat keep
--     communityId NULL (organizer chooses it in the Match Workspace).
-- Players in no chat scope get no membership (organizer assigns them on the
-- Players page). TelegramChatPlayer is left in place, unchanged.

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "communityId" TEXT;

-- AlterTable
ALTER TABLE "TelegramChat" ADD COLUMN     "communityId" TEXT;

-- CreateTable
CREATE TABLE "Community" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityPlayer" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Community_groupId_idx" ON "Community"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Community_id_groupId_key" ON "Community"("id", "groupId");

-- CreateIndex
CREATE INDEX "CommunityPlayer_groupId_idx" ON "CommunityPlayer"("groupId");

-- CreateIndex
CREATE INDEX "CommunityPlayer_playerId_idx" ON "CommunityPlayer"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPlayer_communityId_playerId_key" ON "CommunityPlayer"("communityId", "playerId");

-- CreateIndex
CREATE INDEX "Match_communityId_idx" ON "Match"("communityId");

-- CreateIndex
CREATE INDEX "TelegramChat_communityId_idx" ON "TelegramChat"("communityId");

-- Backfill 1: one Community per existing Telegram chat binding.
INSERT INTO "Community" ("id", "groupId", "name", "isActive", "createdAt", "updatedAt")
SELECT 'com_tc_' || c."id", c."groupId",
       COALESCE(NULLIF(BTRIM(c."title"), ''), 'Telegram group ' || c."id"),
       c."disconnectedAt" IS NULL, c."createdAt", CURRENT_TIMESTAMP
FROM "TelegramChat" c;

UPDATE "TelegramChat" SET "communityId" = 'com_tc_' || "id";

-- Backfill 2: memberships ONLY from the organizer-curated chat scope.
INSERT INTO "CommunityPlayer" ("id", "groupId", "communityId", "playerId", "createdByUserId", "createdAt")
SELECT 'cp_' || s."id", s."groupId", 'com_tc_' || s."telegramChatId", s."playerId", s."createdByUserId", s."createdAt"
FROM "TelegramChatPlayer" s;

-- Backfill 3: a Match with a selected chat belongs to that chat's Community.
UPDATE "Match" SET "communityId" = 'com_tc_' || "telegramChatId" WHERE "telegramChatId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Community" ADD CONSTRAINT "Community_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPlayer" ADD CONSTRAINT "CommunityPlayer_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPlayer" ADD CONSTRAINT "CommunityPlayer_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPlayer" ADD CONSTRAINT "CommunityPlayer_playerId_groupId_fkey" FOREIGN KEY ("playerId", "groupId") REFERENCES "Player"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPlayer" ADD CONSTRAINT "CommunityPlayer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

