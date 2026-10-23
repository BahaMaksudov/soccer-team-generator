-- M13B P8B.1 — bound rate-limited retries by the provider's idempotency-key memory.
-- ADDITIVE ONLY: one nullable column on "RsvpInvitation" (when the current idempotency key
-- was first handed to the provider). No existing row changes; no backfill needed (live
-- delivery has never run).
--
-- Rollback (only if M13B P8B.1 is rolled back):
--   ALTER TABLE "RsvpInvitation" DROP COLUMN "idempotencyKeyFirstUsedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261231120000_m13b_p8b1_idempotency_window';

-- AlterTable
ALTER TABLE "RsvpInvitation" ADD COLUMN     "idempotencyKeyFirstUsedAt" TIMESTAMP(3);
