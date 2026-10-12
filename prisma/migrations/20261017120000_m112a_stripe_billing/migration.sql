-- M11.2A — Stripe billing (TEST MODE): three new tables and two enums.
-- Additive only: no existing table or row is changed; no backfill. Organization.plan
-- (M11.1) stays the entitlement projection; Organization.stripeCustomerId (M11.1,
-- reserved) is now used. No card or payment-method data is stored.

-- CreateEnum
CREATE TYPE "StripeEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "BillingCheckoutStatus" AS ENUM ('CREATING', 'OPEN', 'COMPLETED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "stripePriceId" TEXT,
    "interval" TEXT,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "livemode" BOOLEAN NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "status" "StripeEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "organizationId" TEXT,
    "objectId" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCheckoutSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "status" "BillingCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "stripeSessionId" TEXT,
    "url" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_stripeSubscriptionId_key" ON "BillingSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingSubscription_organizationId_idx" ON "BillingSubscription"("organizationId");

-- CreateIndex
CREATE INDEX "StripeEvent_status_idx" ON "StripeEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCheckoutSession_stripeSessionId_key" ON "BillingCheckoutSession"("stripeSessionId");

-- CreateIndex
CREATE INDEX "BillingCheckoutSession_organizationId_status_idx" ON "BillingCheckoutSession"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCheckoutSession" ADD CONSTRAINT "BillingCheckoutSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


