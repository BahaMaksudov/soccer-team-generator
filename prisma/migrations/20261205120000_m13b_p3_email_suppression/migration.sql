-- M13B P3 — email suppression and unsubscribe for RSVP invitation emails.
-- ADDITIVE ONLY: three enums and three new tables with their indexes and foreign
-- keys. No existing table, column or row is changed; nothing is backfilled.
-- Account, password-reset and security emails never consult these tables.
--
-- Rollback (only if M13B P3 is rolled back AND no opt-outs need keeping — they are
-- recipients' wishes, so prefer keeping them):
--   DROP TABLE "EmailUnsubscribeToken"; DROP TABLE "OrganizationEmailOptOut"; DROP TABLE "GlobalEmailSuppression";
--   DROP TYPE "EmailPurpose"; DROP TYPE "EmailOptOutSource"; DROP TYPE "GlobalSuppressionReason";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261205120000_m13b_p3_email_suppression';

-- CreateEnum
CREATE TYPE "GlobalSuppressionReason" AS ENUM ('HARD_BOUNCE', 'SPAM_COMPLAINT');

-- CreateEnum
CREATE TYPE "EmailOptOutSource" AS ENUM ('LINK', 'ONE_CLICK');

-- CreateEnum
CREATE TYPE "EmailPurpose" AS ENUM ('RSVP_INVITATION');

-- CreateTable
CREATE TABLE "GlobalEmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "GlobalSuppressionReason" NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalEmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationEmailOptOut" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" "EmailOptOutSource" NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationEmailOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailUnsubscribeToken" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "EmailPurpose" NOT NULL DEFAULT 'RSVP_INVITATION',
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "EmailUnsubscribeToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalEmailSuppression_email_key" ON "GlobalEmailSuppression"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationEmailOptOut_organizationId_email_key" ON "OrganizationEmailOptOut"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailUnsubscribeToken_tokenHash_key" ON "EmailUnsubscribeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailUnsubscribeToken_organizationId_email_idx" ON "EmailUnsubscribeToken"("organizationId", "email");

-- AddForeignKey
ALTER TABLE "OrganizationEmailOptOut" ADD CONSTRAINT "OrganizationEmailOptOut_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailUnsubscribeToken" ADD CONSTRAINT "EmailUnsubscribeToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

