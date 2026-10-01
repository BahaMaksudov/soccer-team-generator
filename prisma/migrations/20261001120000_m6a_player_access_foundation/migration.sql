-- M6-A — Player access & visibility foundation (migration #14).
--
-- 1. GroupVisibility enum + Group.visibility (existing Groups → PUBLIC,
--    new Groups default LINK).
-- 2. Player.userId: OPTIONAL claimed account. NULL for every existing
--    Player; unique per (groupId, userId); ON DELETE SET NULL so deleting
--    a User never deletes a Player or its history.
-- 3. GroupShareLink: revocable viewer links; only SHA-256 token hashes.
--
-- Additive only: no existing column/constraint/index/row is dropped or
-- rewritten (apart from the new column's backfill above). No tokens,
-- ids or secrets in this file.
--
-- All-or-nothing.
BEGIN;

-- CreateEnum
CREATE TYPE "GroupVisibility" AS ENUM ('PRIVATE', 'LINK', 'PUBLIC');

-- AlterTable — every Group that exists before this migration becomes
-- PUBLIC (exactly today's behavior); only Groups created afterwards get
-- the privacy-conscious LINK default.
ALTER TABLE "Group" ADD COLUMN "visibility" "GroupVisibility" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "Group" ALTER COLUMN "visibility" SET DEFAULT 'LINK';

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "GroupShareLink" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "GroupShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupShareLink_tokenHash_key" ON "GroupShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "GroupShareLink_groupId_idx" ON "GroupShareLink"("groupId");

-- CreateIndex
CREATE INDEX "Player_userId_idx" ON "Player"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_groupId_userId_key" ON "Player"("groupId", "userId");

-- AddForeignKey
ALTER TABLE "GroupShareLink" ADD CONSTRAINT "GroupShareLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShareLink" ADD CONSTRAINT "GroupShareLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
