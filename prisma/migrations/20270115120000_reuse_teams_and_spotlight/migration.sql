-- Reuse previous teams + Random Player Spotlight. ADDITIVE ONLY: one nullable column, one enum,
-- two new tables, their indexes and foreign keys. No existing row is changed; no backfill; no
-- table rewrite (ADD COLUMN ... TEXT without a default is metadata-only in PostgreSQL).
--
-- 1. TeamGeneration.reusedFromGenerationId — provenance of teams reused from an earlier
--    publication (NULL for every existing row and for generated teams). No foreign key: the
--    source row is never modified and may later be overwritten or deleted independently.
--
-- 2. SpotlightRotation (one row per Group: the current cycle) and SpotlightPick (one row per
--    selection; ACTIVE = the Match's current Spotlight, RELEASED = given back). Two PARTIAL
--    unique indexes make the fairness rules hold in the database itself, whatever runs the
--    statement:
--      - at most one ACTIVE pick per Match (repeat / concurrent requests can't pick twice);
--      - a player can be ACTIVE at most once per Group cycle (never picked twice in a cycle).
--
-- Rollback (safe at any time; nothing else references these objects):
--   DROP TABLE "SpotlightPick"; DROP TABLE "SpotlightRotation"; DROP TYPE "SpotlightPickStatus";
--   ALTER TABLE "TeamGeneration" DROP COLUMN "reusedFromGenerationId";

-- CreateEnum
CREATE TYPE "SpotlightPickStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- AlterTable
ALTER TABLE "TeamGeneration" ADD COLUMN     "reusedFromGenerationId" TEXT;

-- CreateTable
CREATE TABLE "SpotlightRotation" (
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotlightRotation_pkey" PRIMARY KEY ("groupId")
);

-- CreateTable
CREATE TABLE "SpotlightPick" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "playerId" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "note" TEXT,
    "status" "SpotlightPickStatus" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotlightPick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpotlightPick_groupId_cycle_idx" ON "SpotlightPick"("groupId", "cycle");

-- CreateIndex
CREATE INDEX "SpotlightPick_matchId_idx" ON "SpotlightPick"("matchId");

-- AddForeignKey
ALTER TABLE "SpotlightRotation" ADD CONSTRAINT "SpotlightRotation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotlightPick" ADD CONSTRAINT "SpotlightPick_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotlightPick" ADD CONSTRAINT "SpotlightPick_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotlightPick" ADD CONSTRAINT "SpotlightPick_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotlightPick" ADD CONSTRAINT "SpotlightPick_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Fairness invariants (partial unique indexes; Prisma cannot express these — keep them).
CREATE UNIQUE INDEX "SpotlightPick_match_active_key" ON "SpotlightPick"("matchId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "SpotlightPick_cycle_player_active_key" ON "SpotlightPick"("groupId", "cycle", "playerId") WHERE "status" = 'ACTIVE';
