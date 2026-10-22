-- M13B P4 hardening — durable RSVP email quota ledger. ADDITIVE ONLY: one new table
-- ("RsvpEmailUsage": organization, UTC day, consumed count — no recipient data, no match
-- or player reference) plus a backfill from existing SENT / UNCERTAIN invitations. No
-- existing row or column changes. Deleting a match or player no longer gives consumed
-- allowance back; active reservations (QUEUED / SENDING) stay counted live from
-- "RsvpInvitation", so nothing is counted twice.
--
-- Rollback (only if the P4 hardening is rolled back):
--   DROP TABLE "RsvpEmailUsage";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261212120000_m13b_p4_quota_ledger';

-- CreateTable
CREATE TABLE "RsvpEmailUsage" (
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RsvpEmailUsage_pkey" PRIMARY KEY ("organizationId","day"),
    CONSTRAINT "RsvpEmailUsage_consumed_nonnegative" CHECK ("consumed" >= 0)
);

-- AddForeignKey
ALTER TABLE "RsvpEmailUsage" ADD CONSTRAINT "RsvpEmailUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: consumed invitations so far, by the UTC day of their reservation ("reservedAt"
-- is stored as UTC without a time zone, so ::date is the UTC calendar day).
INSERT INTO "RsvpEmailUsage" ("organizationId", "day", "consumed")
SELECT "organizationId", "reservedAt"::date, count(*)::int
FROM "RsvpInvitation"
WHERE "status" IN ('SENT', 'UNCERTAIN') AND "reservedAt" IS NOT NULL
GROUP BY "organizationId", "reservedAt"::date;
