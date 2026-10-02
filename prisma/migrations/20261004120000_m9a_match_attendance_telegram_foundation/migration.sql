-- M9-A — Match, attendance and Telegram foundation (migration #18).
--
-- Additive only: new enums/tables, an appended MessageEventType value, and
-- nullable link columns. No DROP, no destructive change, no UPDATE/backfill.
-- Existing TeamGeneration / TelegramPoll / MessageDelivery rows keep
-- matchId = NULL; TelegramPoll.kind is added with DEFAULT 'ATTENDANCE'
-- (metadata-only default in PostgreSQL 11+, no table rewrite), so every
-- legacy poll reads as an attendance poll. Match is NOT unique by date.

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PLAYING', 'NOT_PLAYING', 'MAYBE');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "TelegramPollKind" AS ENUM ('ATTENDANCE', 'MVP');

-- AlterEnum
ALTER TYPE "MessageEventType" ADD VALUE 'ATTENDANCE_POLL_POSTED';

-- AlterTable
ALTER TABLE "MessageDelivery" ADD COLUMN     "matchId" TEXT;

-- AlterTable
ALTER TABLE "TeamGeneration" ADD COLUMN     "matchId" TEXT;

-- AlterTable
ALTER TABLE "TelegramPoll" ADD COLUMN     "kind" "TelegramPollKind" NOT NULL DEFAULT 'ATTENDANCE',
ADD COLUMN     "matchId" TEXT;

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT,
    "locationName" TEXT,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "attendanceClosedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceResponse" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "participantStatus" "AttendanceStatus",
    "participantSource" "AttendanceSource",
    "participantRespondedAt" TIMESTAMP(3),
    "overrideStatus" "AttendanceStatus",
    "overrideByUserId" TEXT,
    "overrideAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramChatBindCode" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "usedAt" TIMESTAMP(3),
    "usedChatTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramChatBindCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Match_groupId_idx" ON "Match"("groupId");

-- CreateIndex
CREATE INDEX "Match_groupId_date_idx" ON "Match"("groupId", "date");

-- CreateIndex
CREATE INDEX "AttendanceResponse_groupId_idx" ON "AttendanceResponse"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceResponse_matchId_playerId_key" ON "AttendanceResponse"("matchId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChatBindCode_codeHash_key" ON "TelegramChatBindCode"("codeHash");

-- CreateIndex
CREATE INDEX "TelegramChatBindCode_groupId_idx" ON "TelegramChatBindCode"("groupId");

-- CreateIndex
CREATE INDEX "MessageDelivery_matchId_eventType_channel_idx" ON "MessageDelivery"("matchId", "eventType", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "TeamGeneration_matchId_key" ON "TeamGeneration"("matchId");

-- CreateIndex
CREATE INDEX "TelegramPoll_matchId_idx" ON "TelegramPoll"("matchId");

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamGeneration" ADD CONSTRAINT "TeamGeneration_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramPoll" ADD CONSTRAINT "TelegramPoll_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceResponse" ADD CONSTRAINT "AttendanceResponse_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceResponse" ADD CONSTRAINT "AttendanceResponse_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceResponse" ADD CONSTRAINT "AttendanceResponse_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceResponse" ADD CONSTRAINT "AttendanceResponse_overrideByUserId_fkey" FOREIGN KEY ("overrideByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChatBindCode" ADD CONSTRAINT "TelegramChatBindCode_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChatBindCode" ADD CONSTRAINT "TelegramChatBindCode_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

