-- M6-B — durable message delivery (migration #15).
--
-- 1. MessageChannel / MessageEventType / MessageDeliveryStatus enums.
-- 2. MessageDelivery: one row per delivery of a core event to a channel
--    destination (Telegram chat). Group RESTRICT (tenant history),
--    poll/generation/user links SET NULL (history kept).
-- 3. Backfill: every TelegramPoll that already carries a canonical posting
--    state becomes a delivery row so it can never be posted again as a
--    "first" post:  POSTED → SENT,  SENDING → UNCERTAIN (organizer must
--    resolve). contentHash 'legacy' = content not known for old posts.
--
-- Additive only. The old TelegramPoll posting columns are NOT dropped or
-- changed (new code still writes them on success, keeping a rollback to
-- the previous release safe). No tokens, URLs or secrets in this file.
--
-- All-or-nothing.
BEGIN;

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('TELEGRAM');

-- CreateEnum
CREATE TYPE "MessageEventType" AS ENUM ('TEAMS_PUBLISHED');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "eventType" "MessageEventType" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "destination" TEXT NOT NULL,
    "telegramPollId" TEXT,
    "teamGenerationId" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "failureCode" TEXT,
    "failureDetail" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageDelivery_groupId_idx" ON "MessageDelivery"("groupId");

-- CreateIndex
CREATE INDEX "MessageDelivery_telegramPollId_channel_idx" ON "MessageDelivery"("telegramPollId", "channel");

-- CreateIndex
CREATE INDEX "MessageDelivery_teamGenerationId_idx" ON "MessageDelivery"("teamGenerationId");

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_telegramPollId_fkey" FOREIGN KEY ("telegramPollId") REFERENCES "TelegramPoll"("pollId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_teamGenerationId_fkey" FOREIGN KEY ("teamGenerationId") REFERENCES "TeamGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing canonical posting state (deterministic ids).
INSERT INTO "MessageDelivery" (
    "id", "groupId", "eventType", "channel", "destination", "telegramPollId", "teamGenerationId",
    "contentHash", "status", "attempts", "claimedAt", "sentAt", "failureCode", "createdAt", "updatedAt"
)
SELECT
    'legacy-' || p."pollId",
    p."groupId",
    'TEAMS_PUBLISHED'::"MessageEventType",
    'TELEGRAM'::"MessageChannel",
    p."chatId"::text,
    p."pollId",
    tg."id",
    'legacy',
    CASE WHEN p."teamsPostStatus" = 'POSTED' THEN 'SENT'::"MessageDeliveryStatus" ELSE 'UNCERTAIN'::"MessageDeliveryStatus" END,
    1,
    COALESCE(p."teamsPostClaimedAt", p."teamsPostedAt", p."updatedAt"),
    p."teamsPostedAt",
    CASE WHEN p."teamsPostStatus" = 'SENDING' THEN 'STALE_RESERVATION' ELSE NULL END,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "TelegramPoll" p
LEFT JOIN "TeamGeneration" tg ON tg."id" = p."postedTeamGenerationId" AND tg."groupId" = p."groupId"
WHERE p."teamsPostStatus" IS NOT NULL;

COMMIT;
