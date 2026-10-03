-- M9-D — Match result, MVP voting and recap (migration #20).
--
-- Additive only: three new enums, four appended MessageEventType values and
-- four new Match-keyed tables. No existing table is altered; no row is
-- created, updated or deleted (no result/MVP/recap appears for existing
-- Matches). Each table holds at most one row per Match (UNIQUE matchId),
-- except MatchMvpVote: one current vote per (Match, voter Player).
-- MatchMvpVote's composite FKs keep voter and candidate Players inside the
-- row's Group.

-- CreateEnum
CREATE TYPE "MvpVoteSource" AS ENUM ('TELEGRAM', 'WEB');

-- CreateEnum
CREATE TYPE "MvpDecision" AS ENUM ('VOTES', 'CO_MVP', 'ORGANIZER_TIEBREAK');

-- CreateEnum
CREATE TYPE "RecapSource" AS ENUM ('DETERMINISTIC', 'AI', 'AI_EDITED', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageEventType" ADD VALUE 'MVP_POLL_POSTED';
ALTER TYPE "MessageEventType" ADD VALUE 'MATCH_RESULT_POSTED';
ALTER TYPE "MessageEventType" ADD VALUE 'MVP_ANNOUNCED';
ALTER TYPE "MessageEventType" ADD VALUE 'MATCH_RECAP_POSTED';

-- CreateTable
CREATE TABLE "MatchResult" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "scoresJson" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMvp" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "candidatePlayerIds" TEXT[],
    "openedAt" TIMESTAMP(3),
    "openedByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "winnerPlayerIds" TEXT[],
    "decision" "MvpDecision",
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchMvp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchMvpVote" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "voterPlayerId" TEXT NOT NULL,
    "candidatePlayerId" TEXT NOT NULL,
    "source" "MvpVoteSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchMvpVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchRecap" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "content" TEXT,
    "source" "RecapSource",
    "generatedContent" TEXT,
    "generatedAt" TIMESTAMP(3),
    "generatedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchRecap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchResult_matchId_key" ON "MatchResult"("matchId");

-- CreateIndex
CREATE INDEX "MatchResult_groupId_idx" ON "MatchResult"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchMvp_matchId_key" ON "MatchMvp"("matchId");

-- CreateIndex
CREATE INDEX "MatchMvp_groupId_idx" ON "MatchMvp"("groupId");

-- CreateIndex
CREATE INDEX "MatchMvpVote_groupId_idx" ON "MatchMvpVote"("groupId");

-- CreateIndex
CREATE INDEX "MatchMvpVote_candidatePlayerId_idx" ON "MatchMvpVote"("candidatePlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchMvpVote_matchId_voterPlayerId_key" ON "MatchMvpVote"("matchId", "voterPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchRecap_matchId_key" ON "MatchRecap"("matchId");

-- CreateIndex
CREATE INDEX "MatchRecap_groupId_idx" ON "MatchRecap"("groupId");

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvp" ADD CONSTRAINT "MatchMvp_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvp" ADD CONSTRAINT "MatchMvp_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvp" ADD CONSTRAINT "MatchMvp_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvp" ADD CONSTRAINT "MatchMvp_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvpVote" ADD CONSTRAINT "MatchMvpVote_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvpVote" ADD CONSTRAINT "MatchMvpVote_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvpVote" ADD CONSTRAINT "MatchMvpVote_voterPlayerId_groupId_fkey" FOREIGN KEY ("voterPlayerId", "groupId") REFERENCES "Player"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchMvpVote" ADD CONSTRAINT "MatchMvpVote_candidatePlayerId_groupId_fkey" FOREIGN KEY ("candidatePlayerId", "groupId") REFERENCES "Player"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRecap" ADD CONSTRAINT "MatchRecap_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRecap" ADD CONSTRAINT "MatchRecap_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRecap" ADD CONSTRAINT "MatchRecap_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRecap" ADD CONSTRAINT "MatchRecap_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchRecap" ADD CONSTRAINT "MatchRecap_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

