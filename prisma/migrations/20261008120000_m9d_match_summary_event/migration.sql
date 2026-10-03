-- M9-D — combined "Post Match Summary" delivery event (migration #22).
--
-- Additive only: appends one MessageEventType value. No table is altered and
-- no MessageDelivery row is created, updated or deleted.

-- AlterEnum
ALTER TYPE "MessageEventType" ADD VALUE 'MATCH_SUMMARY_POSTED';
