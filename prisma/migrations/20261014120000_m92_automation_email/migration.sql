-- M9.2 — attendance-ready organizer email, delivered idempotently PER RECIPIENT.
-- Additive only: one new table (no backfill; existing MatchAutomation rows are
-- untouched — a Match already notified keeps notifiedAt and is never re-sent).

-- CreateTable
CREATE TABLE "MatchAutomationEmail" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchAutomationEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchAutomationEmail_userId_idx" ON "MatchAutomationEmail"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAutomationEmail_automationId_userId_key" ON "MatchAutomationEmail"("automationId", "userId");

-- AddForeignKey
ALTER TABLE "MatchAutomationEmail" ADD CONSTRAINT "MatchAutomationEmail_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "MatchAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAutomationEmail" ADD CONSTRAINT "MatchAutomationEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


