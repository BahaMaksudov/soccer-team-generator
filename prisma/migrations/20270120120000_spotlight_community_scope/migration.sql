-- Random Player Spotlight — per-Community rotations. ADDITIVE and backward-compatible:
-- one nullable column, one new table, indexes and foreign keys. NO existing row is changed
-- (no backfill), nothing is deleted, no table rewrite (ADD COLUMN ... TEXT without a default
-- is metadata-only in PostgreSQL).
--
-- Rotation SCOPE of a pick = SpotlightPick.communityId:
--   * a Community id  → that Community's own rotation (cycle in SpotlightCommunityRotation);
--   * NULL            → the whole-Group rotation (cycle in SpotlightRotation, unchanged).
-- Every pick that exists before this migration was drawn in the whole-Group rotation, so it
-- stays NULL: history is kept exactly where it was made and is never attributed to a Community
-- automatically.
--
-- Fairness index: "at most one counted pick (ACTIVE or REPLACED) per player per cycle" becomes
-- per SCOPE, so the same player can take part independently in two Communities' rotations (and
-- the whole-Group one). The new index is created BEFORE the old Group-wide one is dropped, and
-- for NULL-scope rows it is exactly the old rule — the previous release (which only writes NULL
-- scope) stays protected while both versions run. "One ACTIVE pick per Match" is unchanged.
--
-- Rollback:
--   * Application rollback needs NO database change: the previous release never reads the new
--     column or table. It would treat Community picks as Group-wide turns (its old behavior), but
--     no constraint can fail and no row is changed. Do NOT recreate the old
--     Group-wide index "SpotlightPick_cycle_player_active_key" once Community picks exist: the
--     same player may legitimately hold a pick in two scopes with the same cycle number.

-- AlterTable
ALTER TABLE "SpotlightPick" ADD COLUMN "communityId" TEXT;

-- CreateTable
CREATE TABLE "SpotlightCommunityRotation" (
    "communityId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotlightCommunityRotation_pkey" PRIMARY KEY ("communityId")
);

-- CreateIndex
CREATE INDEX "SpotlightCommunityRotation_groupId_idx" ON "SpotlightCommunityRotation"("groupId");

-- CreateIndex
CREATE INDEX "SpotlightPick_groupId_communityId_cycle_idx" ON "SpotlightPick"("groupId", "communityId", "cycle");

-- AddForeignKey
ALTER TABLE "SpotlightCommunityRotation" ADD CONSTRAINT "SpotlightCommunityRotation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (same Group enforced by the composite key, like CommunityPlayer)
ALTER TABLE "SpotlightCommunityRotation" ADD CONSTRAINT "SpotlightCommunityRotation_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NULL communityId = whole-Group scope; the composite key is then not checked)
ALTER TABLE "SpotlightPick" ADD CONSTRAINT "SpotlightPick_communityId_groupId_fkey" FOREIGN KEY ("communityId", "groupId") REFERENCES "Community"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fairness invariant per rotation scope (expression + partial unique index; Prisma cannot
-- express it — keep it). Created first, then the Group-wide predecessor is dropped.
CREATE UNIQUE INDEX "SpotlightPick_scope_cycle_player_active_key" ON "SpotlightPick"("groupId", COALESCE("communityId", ''), "cycle", "playerId") WHERE "status" <> 'RELEASED';
DROP INDEX "SpotlightPick_cycle_player_active_key";
