-- M13B P7 — RSVP invitation retention. ADDITIVE ONLY: one enum value, two nullable
-- columns and one index. No existing row changes; nothing is cleaned up by this migration
-- (the cleanup is a separate, explicitly invoked job — src/lib/rsvpRetention.ts).
--
-- Rollback (only if M13B P7 is rolled back):
--   DROP INDEX "RsvpInvitation_anonymizedAt_matchId_idx";
--   ALTER TABLE "RsvpInvitation" DROP COLUMN "anonymizedAt";
--   ALTER TABLE "RsvpSend" DROP COLUMN "retentionHoldUntil";
--   The enum value 'RECIPIENT_REQUEST' cannot be dropped in place (PostgreSQL); it is
--   harmless if unused. Removing it needs a type rebuild after deleting rows that use it.
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261225120000_m13b_p7_retention';
-- NOTE: anonymization performed by the cleanup job is NOT reversible by rolling back.

-- AlterEnum
ALTER TYPE "GlobalSuppressionReason" ADD VALUE 'RECIPIENT_REQUEST';

-- AlterTable
ALTER TABLE "RsvpInvitation" ADD COLUMN     "anonymizedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RsvpSend" ADD COLUMN     "retentionHoldUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "RsvpInvitation_anonymizedAt_matchId_idx" ON "RsvpInvitation"("anonymizedAt", "matchId");
