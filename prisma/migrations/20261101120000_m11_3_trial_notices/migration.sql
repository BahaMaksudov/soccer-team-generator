-- M11.3 — trial lifecycle: the idempotency record of trial reminder / expiry emails.
-- Additive only: one new enum and one new table (empty). No existing table, column,
-- row or constraint is changed. Code without this table never reads or writes it.
--
-- Rollback (after reverting the code that uses it):
--   DROP TABLE "TrialNotice"; DROP TYPE "TrialNoticeStatus";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101120000_m11_3_trial_notices';

-- CreateEnum
CREATE TYPE "TrialNoticeStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "TrialNotice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "daysLeft" INTEGER,
    "status" "TrialNoticeStatus" NOT NULL DEFAULT 'SENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "TrialNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrialNotice_status_idx" ON "TrialNotice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TrialNotice_organizationId_stage_trialEndsAt_userId_key" ON "TrialNotice"("organizationId", "stage", "trialEndsAt", "userId");

-- AddForeignKey
ALTER TABLE "TrialNotice" ADD CONSTRAINT "TrialNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialNotice" ADD CONSTRAINT "TrialNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
