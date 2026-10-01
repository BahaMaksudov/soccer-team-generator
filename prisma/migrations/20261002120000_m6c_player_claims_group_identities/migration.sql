-- M6-C — Player claiming & Group-scoped channel identities (migration #16).
--
-- 1. PlayerClaim: organizer-issued, single-use, expiring claim links
--    (SHA-256 token hashes only) + claim/unlink audit fields.
-- 2. TelegramConnectCode: short-lived, single-use /connect codes
--    (SHA-256 code hashes only).
-- 3. TelegramUserLink: replace the GLOBAL unique on userId with a
--    Group-scoped unique (groupId, userId), so one Telegram user can be
--    linked to one Player in each Group. playerId stays unique (a Player
--    belongs to exactly one Group). The new index is created BEFORE the
--    old one is dropped; it cannot fail on existing data because every
--    existing userId is already globally unique. No TelegramUserLink row
--    is inserted, updated or deleted.
--
-- Additive otherwise. No tokens, ids or secrets in this file.
--
-- All-or-nothing.
BEGIN;

-- Group-scoped Telegram identity (create new constraint first, then drop the global one).
CREATE UNIQUE INDEX "TelegramUserLink_groupId_userId_key" ON "TelegramUserLink"("groupId", "userId");
DROP INDEX "TelegramUserLink_userId_key";

-- CreateTable
CREATE TABLE "PlayerClaim" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "usedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "unlinkedAt" TIMESTAMP(3),
    "unlinkedByUserId" TEXT,

    CONSTRAINT "PlayerClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramConnectCode" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "usedAt" TIMESTAMP(3),
    "usedByTelegramUserId" BIGINT,

    CONSTRAINT "TelegramConnectCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerClaim_tokenHash_key" ON "PlayerClaim"("tokenHash");

-- CreateIndex
CREATE INDEX "PlayerClaim_playerId_idx" ON "PlayerClaim"("playerId");

-- CreateIndex
CREATE INDEX "PlayerClaim_groupId_idx" ON "PlayerClaim"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnectCode_codeHash_key" ON "TelegramConnectCode"("codeHash");

-- CreateIndex
CREATE INDEX "TelegramConnectCode_playerId_idx" ON "TelegramConnectCode"("playerId");


-- AddForeignKey
ALTER TABLE "PlayerClaim" ADD CONSTRAINT "PlayerClaim_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerClaim" ADD CONSTRAINT "PlayerClaim_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerClaim" ADD CONSTRAINT "PlayerClaim_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerClaim" ADD CONSTRAINT "PlayerClaim_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerClaim" ADD CONSTRAINT "PlayerClaim_unlinkedByUserId_fkey" FOREIGN KEY ("unlinkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnectCode" ADD CONSTRAINT "TelegramConnectCode_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnectCode" ADD CONSTRAINT "TelegramConnectCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnectCode" ADD CONSTRAINT "TelegramConnectCode_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
