-- M13B P8A.1 — provider rate-limit safety. ADDITIVE ONLY: one nullable column on
-- "RsvpInvitation" ("notBefore": a rate-limited hand-off waits until then, keeping its
-- idempotency key) and one single-row table ("RsvpDeliveryPacer": global pacing of live
-- hand-offs across workers; no personal data). No existing row changes.
--
-- Rollback (only if M13B P8A.1 is rolled back):
--   DROP TABLE "RsvpDeliveryPacer";
--   ALTER TABLE "RsvpInvitation" DROP COLUMN "notBefore";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261230120000_m13b_p8a1_delivery_pacing';

-- AlterTable
ALTER TABLE "RsvpInvitation" ADD COLUMN     "notBefore" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RsvpDeliveryPacer" (
    "id" INTEGER NOT NULL,
    "nextSlotAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RsvpDeliveryPacer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RsvpDeliveryPacer_single_row" CHECK ("id" = 1)
);
