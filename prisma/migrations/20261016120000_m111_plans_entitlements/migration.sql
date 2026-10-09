-- M11.1 — plans, introductory trial and entitlements (no Stripe workflow).
-- Additive only: two enums, nullable/defaulted columns, two new tables.
--
-- Grandfathering (safety): every Organization that already exists when this
-- migration runs becomes LEGACY — it keeps exactly the capabilities it has
-- today (no limits) until the product owner decides its treatment (COMP,
-- trial or Free) through the audited entitlement mechanism. Each one gets an
-- EntitlementEvent recording why. New Organizations created after this
-- migration start on FREE (with the introductory trial when eligible).
-- No User is marked as having used a trial; no data is deleted.

-- CreateEnum
CREATE TYPE "OrganizationPlan" AS ENUM ('FREE', 'PRO', 'COMP', 'LEGACY');

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('RESERVED', 'SUCCEEDED', 'RELEASED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "trialUsedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "plan" "OrganizationPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "trialStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT,
    "period" TEXT NOT NULL,
    "status" "AiUsageStatus" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromPlan" "OrganizationPlan",
    "toPlan" "OrganizationPlan",
    "trialEndsAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_organizationId_period_status_idx" ON "AiUsage"("organizationId", "period", "status");

-- CreateIndex
CREATE INDEX "EntitlementEvent_organizationId_idx" ON "EntitlementEvent"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementEvent" ADD CONSTRAINT "EntitlementEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Grandfather the Organizations that exist right now (auditable).
UPDATE "Organization" SET "plan" = 'LEGACY';
INSERT INTO "EntitlementEvent" ("id", "organizationId", "action", "fromPlan", "toPlan", "trialEndsAt", "reason", "actor", "createdAt")
SELECT 'ee_m111_' || "id", "id", 'GRANDFATHERED', NULL, 'LEGACY', NULL,
       'Existed before M11 plans; keeps current capabilities until the product owner decides.', 'migration:20261016120000_m111_plans_entitlements', CURRENT_TIMESTAMP
FROM "Organization";
