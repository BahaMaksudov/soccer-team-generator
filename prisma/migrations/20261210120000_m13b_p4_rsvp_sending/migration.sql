-- M13B P4 — RSVP email sending ledger. ADDITIVE ONLY: four enums, two new tables
-- (RsvpSend, RsvpInvitation) with indexes and foreign keys, and one new column on
-- "PersonalAttendanceLink" ("channel", NOT NULL with DEFAULT 'MANUAL' — every existing
-- link becomes MANUAL; no other existing row or column changes).
--
-- Rollback (only if M13B P4 is rolled back AND the send ledger isn't needed):
--   DROP TABLE "RsvpInvitation"; DROP TABLE "RsvpSend";
--   ALTER TABLE "PersonalAttendanceLink" DROP COLUMN "channel";
--   DROP TYPE "RsvpRecipientType"; DROP TYPE "RsvpDeliveryStatus"; DROP TYPE "RsvpSendKind"; DROP TYPE "PersonalLinkChannel";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261210120000_m13b_p4_rsvp_sending';

-- CreateEnum
CREATE TYPE "PersonalLinkChannel" AS ENUM ('MANUAL', 'EMAIL');

-- CreateEnum
CREATE TYPE "RsvpSendKind" AS ENUM ('INITIAL', 'RESEND');

-- CreateEnum
CREATE TYPE "RsvpDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RsvpRecipientType" AS ENUM ('PLAYER', 'GUARDIAN', 'ACCOUNT');

-- AlterTable
ALTER TABLE "PersonalAttendanceLink" ADD COLUMN     "channel" "PersonalLinkChannel" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "RsvpSend" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "kind" "RsvpSendKind" NOT NULL,
    "round" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RsvpSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RsvpInvitation" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT,
    "round" INTEGER NOT NULL,
    "email" TEXT,
    "recipientType" "RsvpRecipientType",
    "status" "RsvpDeliveryStatus" NOT NULL,
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reservedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "linkId" TEXT,
    "unsubscribeTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsvpInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RsvpSend_requestKey_key" ON "RsvpSend"("requestKey");

-- CreateIndex
CREATE INDEX "RsvpSend_organizationId_createdAt_idx" ON "RsvpSend"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RsvpSend_matchId_round_key" ON "RsvpSend"("matchId", "round");

-- CreateIndex
CREATE INDEX "RsvpInvitation_organizationId_status_reservedAt_idx" ON "RsvpInvitation"("organizationId", "status", "reservedAt");

-- CreateIndex
CREATE INDEX "RsvpInvitation_status_claimedAt_idx" ON "RsvpInvitation"("status", "claimedAt");

-- CreateIndex
CREATE INDEX "RsvpInvitation_sendId_idx" ON "RsvpInvitation"("sendId");

-- CreateIndex
CREATE UNIQUE INDEX "RsvpInvitation_matchId_playerId_round_key" ON "RsvpInvitation"("matchId", "playerId", "round");

-- AddForeignKey
ALTER TABLE "RsvpSend" ADD CONSTRAINT "RsvpSend_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpSend" ADD CONSTRAINT "RsvpSend_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpSend" ADD CONSTRAINT "RsvpSend_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpSend" ADD CONSTRAINT "RsvpSend_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "RsvpSend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "PersonalAttendanceLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RsvpInvitation" ADD CONSTRAINT "RsvpInvitation_unsubscribeTokenId_fkey" FOREIGN KEY ("unsubscribeTokenId") REFERENCES "EmailUnsubscribeToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

