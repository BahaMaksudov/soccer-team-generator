-- M12-A — credentials sign-in attempt log (database-backed login rate limit).
-- Additive only: one new enum and one new empty table with its indexes. No
-- existing table, column, row or constraint is changed. Ordered after
-- 20261110120000_m12a_oauth_accounts (same unreleased milestone).
--
-- Rollback (after reverting the code that uses it):
--   DROP TABLE "LoginAttempt"; DROP TYPE "LoginAttemptOutcome";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261110130000_m12a_login_attempts';

-- CreateEnum
CREATE TYPE "LoginAttemptOutcome" AS ENUM ('PENDING', 'SUCCESS', 'FAILURE', 'BLOCKED');

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "outcome" "LoginAttemptOutcome" NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginAttempt_emailHash_createdAt_idx" ON "LoginAttempt"("emailHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipHash_createdAt_idx" ON "LoginAttempt"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_emailHash_ipHash_outcome_createdAt_idx" ON "LoginAttempt"("emailHash", "ipHash", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");

