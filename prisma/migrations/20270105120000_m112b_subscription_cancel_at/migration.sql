-- M11.2B — when a subscription is scheduled to end (Stripe "cancel_at").
-- The Stripe Customer Portal schedules an end-of-period cancellation with
-- cancel_at (cancel_at_period_end stays false), and a Dashboard cancellation
-- can pick any date. Nullable, no default: existing rows stay NULL
-- (metadata-only ALTER, no table rewrite, no backfill; the next sync fills it).
-- Rollback: ALTER TABLE "BillingSubscription" DROP COLUMN "cancelAt";
ALTER TABLE "BillingSubscription" ADD COLUMN "cancelAt" TIMESTAMP(3);
