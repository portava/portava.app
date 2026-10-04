-- Rollback for 3821_payment_ledger.sql (task PAY-T05).
-- Rehearsed on a private throwaway PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3821 DID
-- =============
-- Created public.payment_parties, payment_accounts, payment_transactions and
-- payment_ledger_entries with their triggers and trigger functions, and
-- public.payment_account_ensure(jsonb).
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES while 3822 or 3823 is applied: roll those back first (3823, 3822,
-- then this file).
-- It REFUSES while ANY of the four tables holds a row. They are financial
-- records and the only link between a person and them; dropping them is a
-- retention decision (owner ruling 2026-10-04: kept for a defined period), not
-- a rollback. Nothing is changed.
-- With all four empty it drops the tables, the eight functions and 3821's
-- ledger row.

BEGIN;

DO $pre$
DECLARE n bigint; t text;
BEGIN
  IF to_regprocedure('public.payment_post_transaction(jsonb)') IS NOT NULL
     OR to_regclass('public.payment_account_balances') IS NOT NULL
     OR to_regclass('public.payment_balance_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3821): 3822 is applied. Roll it back first.';
  END IF;
  IF to_regprocedure('public.payment_party_ledger(jsonb)') IS NOT NULL
     OR to_regprocedure('public.payment_party_remove_identity(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3821): 3823 is applied. Roll it back first.';
  END IF;
  FOREACH t IN ARRAY ARRAY['payment_ledger_entries', 'payment_transactions', 'payment_accounts', 'payment_parties'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED (3821): % holds % row(s). Dropping financial records is a retention decision, not a rollback. Nothing has been changed.', t, n;
      END IF;
    END IF;
  END LOOP;
END
$pre$;

DROP FUNCTION IF EXISTS public.payment_account_ensure(jsonb);
DROP TABLE IF EXISTS public.payment_ledger_entries;
DROP TABLE IF EXISTS public.payment_transactions;
DROP TABLE IF EXISTS public.payment_accounts;
DROP TABLE IF EXISTS public.payment_parties;
DROP FUNCTION IF EXISTS public.payment_entry_transaction_balances();
DROP FUNCTION IF EXISTS public.payment_transaction_has_balanced_entries();
DROP FUNCTION IF EXISTS public.payment_assert_transaction_balanced(uuid);
DROP FUNCTION IF EXISTS public.payment_entry_transaction_is_open();
DROP FUNCTION IF EXISTS public.payment_transaction_open();
DROP FUNCTION IF EXISTS public.payment_party_identity_guard();
DROP FUNCTION IF EXISTS public.payment_ledger_append_only();

DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3821_payment_ledger.sql';
  END IF;
END
$ledger$;

COMMIT;

DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.payment_ledger_entries') IS NOT NULL OR to_regclass('public.payment_transactions') IS NOT NULL
     OR to_regclass('public.payment_accounts') IS NOT NULL OR to_regclass('public.payment_parties') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3821 rollback): a table survived.';
  END IF;
  SELECT count(*) INTO n FROM pg_proc f JOIN pg_namespace ns ON ns.oid = f.pronamespace
   WHERE ns.nspname = 'public' AND f.proname IN (
     'payment_account_ensure', 'payment_entry_transaction_balances', 'payment_transaction_has_balanced_entries',
     'payment_assert_transaction_balanced', 'payment_entry_transaction_is_open', 'payment_transaction_open',
     'payment_party_identity_guard', 'payment_ledger_append_only');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3821 rollback): % of 3821''s 8 functions survived.', n;
  END IF;
END $post$;
