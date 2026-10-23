-- M13B P8A — one enum value: an organization opt-out recorded by support for a verified
-- recipient request about ONE organization. ADDITIVE ONLY; no row changes.
-- (The Prisma field RsvpInvitation.identifiersRemovedAt maps to the existing column
-- "anonymizedAt" — a rename in code only; no database change.)
--
-- Rollback: the value cannot be dropped in place (PostgreSQL); it is harmless if unused.
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261228120000_m13b_p8a_support_opt_out';

-- AlterEnum
ALTER TYPE "EmailOptOutSource" ADD VALUE 'SUPPORT_REQUEST';
