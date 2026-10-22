-- M13B P5 — organizer send confirmation and emailed-link replacement. ADDITIVE ONLY:
-- two nullable columns on "RsvpSend" (when the organizer confirmed they may contact the
-- listed recipients for match coordination, and the recipient count they reviewed) and
-- one nullable column on "PersonalAttendanceLink" ("replacedAt": revoked because a newer
-- emailed link was accepted). No existing row changes.
--
-- Rollback (only if M13B P5 is rolled back):
--   ALTER TABLE "RsvpSend" DROP COLUMN "attestedAt", DROP COLUMN "confirmedCount";
--   ALTER TABLE "PersonalAttendanceLink" DROP COLUMN "replacedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261215120000_m13b_p5_send_attestation';

-- AlterTable
ALTER TABLE "RsvpSend" ADD COLUMN     "attestedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedCount" INTEGER;

-- AlterTable
ALTER TABLE "PersonalAttendanceLink" ADD COLUMN     "replacedAt" TIMESTAMP(3);
