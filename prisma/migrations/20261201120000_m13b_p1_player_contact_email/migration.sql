-- M13B P1 — organizer-managed player contact email (for future RSVP invitations).
-- ADDITIVE ONLY: one new enum and three NULLABLE columns on "Player" plus a CHECK
-- constraint. No existing row is changed and nothing is backfilled (every existing
-- Player has NULL contact fields, which satisfies the constraint). The linked
-- account's email stays on "User" and is never copied here.
--
-- Rollback (only if M13B P1 is rolled back AND no contact data needs keeping):
--   ALTER TABLE "Player" DROP CONSTRAINT "Player_contactEmail_type_together";
--   ALTER TABLE "Player" DROP COLUMN "contactEmailUpdatedAt", DROP COLUMN "contactEmailType", DROP COLUMN "contactEmail";
--   DROP TYPE "PlayerContactType";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261201120000_m13b_p1_player_contact_email';
-- Older application code never reads these columns, so leaving them is harmless.

-- CreateEnum
CREATE TYPE "PlayerContactType" AS ENUM ('PLAYER', 'GUARDIAN');

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactEmailType" "PlayerContactType",
ADD COLUMN     "contactEmailUpdatedAt" TIMESTAMP(3);


-- The address and whose inbox it is (PLAYER / GUARDIAN) are set and cleared together.
ALTER TABLE "Player" ADD CONSTRAINT "Player_contactEmail_type_together" CHECK (("contactEmail" IS NULL) = ("contactEmailType" IS NULL));
