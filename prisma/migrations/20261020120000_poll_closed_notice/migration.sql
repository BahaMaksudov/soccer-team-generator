-- Telegram publishing — the one-time poll-closure notice ("✅ Poll is closed for M/D/YY").
-- Additive only: ONE new value of the "MessageEventType" enum, used by new
-- MessageDelivery rows (eventType = 'POLL_CLOSED_NOTICE'). No table, column,
-- index, constraint or row is created, changed or removed: existing polls,
-- attendance answers, teams and delivery records are untouched. Code without
-- this value never reads or writes it (backward-compatible).
--
-- Rollback (after reverting the code that uses it):
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261020120000_poll_closed_notice';
-- PostgreSQL cannot drop an enum value: 'POLL_CLOSED_NOTICE' stays in
-- "MessageEventType" (harmless while unused). IF NOT EXISTS keeps a re-apply safe.

-- AlterEnum
ALTER TYPE "MessageEventType" ADD VALUE IF NOT EXISTS 'POLL_CLOSED_NOTICE';
