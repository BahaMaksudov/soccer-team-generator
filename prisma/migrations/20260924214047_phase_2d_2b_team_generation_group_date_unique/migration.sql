BEGIN;

-- DropIndex
DROP INDEX "TeamGeneration_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "TeamGeneration_groupId_date_key" ON "TeamGeneration"("groupId", "date");

COMMIT;
