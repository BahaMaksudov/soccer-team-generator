-- M11.2C — launch safeguards. ADDITIVE ONLY: one nullable column and two triggers.
-- No existing row changes; no backfill; no table rewrite.
--
-- 1. BillingCheckoutSession.requestHash: one-way fingerprint of interval + US
--    billing address + terms version, so an open Checkout created for a
--    different address is never reused (no address is stored).
--
-- 2. Never leave a Stripe subscription charging an organization nobody can
--    manage. The database itself refuses (whatever runs the statement — app,
--    script or SQL console):
--      - deleting an Organization that has a subscription which is not
--        finished (any status other than canceled / incomplete_expired);
--      - removing or demoting the LAST OWNER of such an Organization
--        (this also covers deleting that owner's User, which cascades to the
--        membership).
--    Resolve by cancelling the subscription in Stripe (and letting the webhook
--    or billing reconciliation record it as canceled), or by adding another
--    owner first. TRUNCATE (test databases only) does not fire these.
--
-- Rollback:
--   DROP TRIGGER "tbp_org_delete_billing_guard" ON "Organization";
--   DROP TRIGGER "tbp_owner_billing_guard" ON "OrganizationMembership";
--   DROP FUNCTION tbp_org_delete_billing_guard(); DROP FUNCTION tbp_owner_billing_guard();
--   ALTER TABLE "BillingCheckoutSession" DROP COLUMN "requestHash";

-- AlterTable
ALTER TABLE "BillingCheckoutSession" ADD COLUMN "requestHash" TEXT;

-- Guard: Organization deletion
CREATE FUNCTION tbp_org_delete_billing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BillingSubscription" s
    WHERE s."organizationId" = OLD."id" AND s."status" NOT IN ('canceled', 'incomplete_expired')
  ) THEN
    RAISE EXCEPTION 'TBP_BILLING_GUARD: organization % has a Stripe subscription that is not finished. Cancel it in Stripe and run billing reconciliation before deleting the organization.', OLD."id"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "tbp_org_delete_billing_guard"
  BEFORE DELETE ON "Organization"
  FOR EACH ROW EXECUTE FUNCTION tbp_org_delete_billing_guard();

-- Guard: removing / demoting the last owner (also covers User deletion via cascade)
CREATE FUNCTION tbp_owner_billing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."role" = 'OWNER'
     AND (TG_OP = 'DELETE' OR NEW."role" <> 'OWNER' OR NEW."organizationId" <> OLD."organizationId")
     AND NOT EXISTS (
       SELECT 1 FROM "OrganizationMembership" m
       WHERE m."organizationId" = OLD."organizationId" AND m."role" = 'OWNER' AND m."id" <> OLD."id"
     )
     AND EXISTS (
       SELECT 1 FROM "BillingSubscription" s
       WHERE s."organizationId" = OLD."organizationId" AND s."status" NOT IN ('canceled', 'incomplete_expired')
     )
  THEN
    RAISE EXCEPTION 'TBP_BILLING_GUARD: the last owner of organization % cannot be removed while its Stripe subscription is not finished. Add another owner, or cancel the subscription in Stripe first.', OLD."organizationId"
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tbp_owner_billing_guard"
  BEFORE DELETE OR UPDATE OF "role", "organizationId" ON "OrganizationMembership"
  FOR EACH ROW EXECUTE FUNCTION tbp_owner_billing_guard();
