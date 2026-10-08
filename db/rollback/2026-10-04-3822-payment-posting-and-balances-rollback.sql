-- Rollback for 3822_payment_posting_and_balances.sql (task PAY-T06).
-- Rehearsed on a private throwaway PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3822 DID
-- =============
-- Added public.payment_account_balances (the projection), public.payment_balance_rules
-- (I6 as data, nine seeded rows) and public.payment_post_transaction(jsonb), the
-- only writer of the ledger.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES while 3823 is applied (its read function selects from the
-- projection): roll 3823 back first.
-- It REFUSES while payment_transactions holds a row. With money recorded, this
-- is not a rollback: it would leave a ledger nothing can write to and discard
-- the projection its readers use. Nothing is changed.
-- It REFUSES while payment_balance_rules differs from 3822's seed: a changed
-- row is an owner decision about who carries a loss, and dropping the table
-- would discard it.
-- Otherwise it drops the function and both tables and deletes 3822's ledger row.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regprocedure('public.payment_party_ledger(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3822): 3823 is applied (public.payment_party_ledger reads the projection). Roll 3823 back first.';
  END IF;
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.payment_transactions;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3822): payment_transactions holds % row(s). Removing the posting function and the projection under recorded money is not a rollback. Nothing has been changed.', n;
    END IF;
  END IF;
  IF to_regclass('public.payment_balance_rules') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.payment_balance_rules r
     WHERE NOT (
       (r.account_type = 'user_payable' AND r.normal_side = 'credit' AND r.floor_enforced AND r.overdraft_kinds = ARRAY['chargeback']::text[])
       OR (r.account_type <> 'user_payable' AND NOT r.floor_enforced AND r.overdraft_kinds = '{}'::text[]));
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3822): % balance rule(s) differ from the seed (an owner decision). Nothing has been changed.', n;
    END IF;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.payment_post_transaction(jsonb);
DROP TABLE IF EXISTS public.payment_account_balances;
DROP TABLE IF EXISTS public.payment_balance_rules;

DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3822_payment_posting_and_balances.sql';
  END IF;
END
$ledger$;

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.payment_post_transaction(jsonb)') IS NOT NULL
     OR to_regclass('public.payment_account_balances') IS NOT NULL
     OR to_regclass('public.payment_balance_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3822 rollback): an object survived.';
  END IF;
END $post$;
