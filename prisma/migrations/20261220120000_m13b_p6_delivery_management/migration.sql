-- M13B P6 — contact authorization, one-click-only unsubscribe tokens, webhook idempotency.
-- ADDITIVE ONLY: nullable columns on "Player" (who confirmed a contact may be used for
-- match coordination email, and when — an organizer attestation, not proof of legal
-- guardian consent), a defaulted column on "EmailUnsubscribeToken", and one new table
-- ("EmailWebhookEvent": provider event id + type + outcome — no recipient address).
-- Existing contacts stay UNCONFIRMED (never emailed until an organizer confirms).
--
-- Rollback (only if M13B P6 is rolled back):
--   DROP TABLE "EmailWebhookEvent";
--   ALTER TABLE "EmailUnsubscribeToken" DROP COLUMN "oneClickOnly";
--   ALTER TABLE "Player" DROP CONSTRAINT "Player_contact_authorization_requires_contact";
--   ALTER TABLE "Player" DROP CONSTRAINT "Player_contactAuthorizedByUserId_fkey";
--   ALTER TABLE "Player" DROP COLUMN "contactAuthorizedAt", DROP COLUMN "contactAuthorizedByUserId";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220120000_m13b_p6_delivery_management';

-- AlterTable
ALTER TABLE "EmailUnsubscribeToken" ADD COLUMN     "oneClickOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "contactAuthorizedAt" TIMESTAMP(3),
ADD COLUMN     "contactAuthorizedByUserId" TEXT;

-- An authorization only exists together with a contact address.
ALTER TABLE "Player" ADD CONSTRAINT "Player_contact_authorization_requires_contact"
  CHECK ("contactEmail" IS NOT NULL OR ("contactAuthorizedAt" IS NULL AND "contactAuthorizedByUserId" IS NULL));

-- CreateTable
CREATE TABLE "EmailWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailWebhookEvent_provider_eventId_key" ON "EmailWebhookEvent"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_contactAuthorizedByUserId_fkey" FOREIGN KEY ("contactAuthorizedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
