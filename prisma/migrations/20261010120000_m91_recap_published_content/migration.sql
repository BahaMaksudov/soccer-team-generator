-- M9.1 — separate the saved recap (content) from the published recap (publishedContent).
-- Additive: one nullable column. Backfill ONLY rows already published: before M9.1 a
-- published recap's player-visible text WAS `content` (publishedAt set by Publish, never
-- cleared), so this preserves exactly what players see today. Never-published rows
-- (publishedAt IS NULL) keep publishedContent NULL. `content` is not touched.
ALTER TABLE "MatchRecap" ADD COLUMN "publishedContent" TEXT;

UPDATE "MatchRecap" SET "publishedContent" = "content" WHERE "publishedAt" IS NOT NULL;
