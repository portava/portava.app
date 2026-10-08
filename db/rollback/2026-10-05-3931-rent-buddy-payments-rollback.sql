-- Rollback for 3931_rent_buddy_payments.sql
-- Written 2026-10-05 by lane B. NOT rehearsed on a database (no PostgreSQL on the
-- machine that wrote it). NOT run against portava-ci or production.
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-05-3931-rent-buddy-payments-rollback.sql
--
-- ORDER: deploy an API that does not use these tables FIRST.
-- REFUSES while any of the five tables holds a row: they are financial records
-- (payment attempts, refunds, payouts, provider accounts, event receipts), and a
-- rollback that dropped them would destroy the only record of what the provider
-- was asked to do. Empty tables are dropped; nothing else is touched.

BEGIN;

DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['rent_buddy_payment_refunds', 'rent_buddy_booking_payments', 'rent_buddy_monthly_payouts', 'rent_buddy_payment_recipients', 'payment_webhook_events'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION '3931 rollback REFUSED: public.% holds % row(s) — financial records are not dropped by a rollback', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.rent_buddy_payment_refunds;
DROP TABLE IF EXISTS public.rent_buddy_booking_payments;
DROP TABLE IF EXISTS public.rent_buddy_monthly_payouts;
DROP TABLE IF EXISTS public.rent_buddy_payment_recipients;
DROP TABLE IF EXISTS public.payment_webhook_events;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3931_rent_buddy_payments.sql';
  END IF;
  IF to_regclass('public.rent_buddy_booking_payments') IS NOT NULL THEN
    RAISE EXCEPTION '3931 rollback FAILED: rent_buddy_booking_payments still exists';
  END IF;
END $$;

COMMIT;
