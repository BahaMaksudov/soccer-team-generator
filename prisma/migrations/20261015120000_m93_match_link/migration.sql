-- M9.3 — Web-only participation: the Match Link.
-- Additive only:
--   * AttendanceSource gains LINK (an anonymous answer through the Match Link);
--     existing rows keep WEB / TELEGRAM.
--   * Match.shareVersion (default 1) — every existing Match gets version 1; the
--     link token is an HMAC of (matchId, shareVersion) under MATCH_SHARE_SECRET,
--     so nothing secret is stored. No other backfill; no Telegram data changes.

-- AlterEnum
ALTER TYPE "AttendanceSource" ADD VALUE 'LINK';

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "shareVersion" INTEGER NOT NULL DEFAULT 1;
