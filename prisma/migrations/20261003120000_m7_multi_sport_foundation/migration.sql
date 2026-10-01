-- M7 — Multi-Sport Foundation (migration #17).
--
-- 1) Player.position: soccer-only enum "Position" -> TEXT (a sport-scoped
--    role key validated by the application against the Group's sport).
--    In-place type change: every existing value is preserved byte-for-byte
--    ('GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD'); no row is
--    rewritten to another value and no column is dropped. (Prisma's
--    generated diff would DROP + ADD the column, losing data — not used.)
ALTER TABLE "Player" ALTER COLUMN "position" TYPE TEXT USING "position"::text;

-- The enum is no longer referenced by any column.
DROP TYPE "Position";

-- 2) TeamGeneration metadata recorded on publish from M7 on. Nullable and
--    never backfilled: NULL = legacy (pre-M7) generation.
ALTER TABLE "TeamGeneration"
  ADD COLUMN "sportKey" TEXT,
  ADD COLUMN "engineVersion" TEXT,
  ADD COLUMN "metricsJson" TEXT;
