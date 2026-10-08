-- Rollback for 3823_payment_attribution_and_scoped_reads.sql (task PAY-T07).
-- Rehearsed on a private throwaway PostgreSQL 16 only (apply, re-apply, rollback, re-apply).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3823 DID
-- =============
-- (1) Added the attribution vocabulary CHECKs and the deferred constraint
--     trigger ptx_has_beneficiary_entry to payment_transactions.
-- (2) Added authz.payment_account_owned_by_profile and public.payment_party_ledger.
-- (3) Added public.payment_retention_settings and public.payment_party_remove_identity.
-- (4) Seeded the flag payment_ledger_reads_enabled, FALSE.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES while the flag is TRUE: a TRUE row means the read routes were
-- turned on since 3823 was applied, and dropping the function under them would
-- turn a working read into degraded_unavailable. Turn it off deliberately first.
-- It REFUSES while payment_retention_settings records a retention period:
-- dropping the table would discard an owner decision.
-- Otherwise it drops (2), (3) and (1) and deletes the flag row and 3823's ledger
-- row. It does NOT drop schema authz (2182 owns it where 2182 is applied; where
-- it is not, an empty schema is left behind, which 2182's CREATE SCHEMA IF NOT
-- EXISTS accepts). It does NOT restore any identity link removed through the
-- door: a removed link is gone by design, and 3821's guard forbids restoring it.
-- Run order for a full rollback: 3823, then 3822, then 3821.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3823): payment_ledger_reads_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
  -- Nested, not AND-ed: plpgsql plans the whole condition, so a reference to a
  -- table that is already gone would fail a second run of this file.
  IF to_regclass('public.payment_retention_settings') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.payment_retention_settings WHERE retention_period IS NOT NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3823): payment_retention_settings records a retention period (an owner decision). Nothing has been changed.';
    END IF;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.payment_party_remove_identity(jsonb);
DROP TABLE IF EXISTS public.payment_retention_settings;
DROP FUNCTION IF EXISTS public.payment_party_ledger(jsonb);

DO $authz$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'authz') THEN
    DROP FUNCTION IF EXISTS authz.payment_account_owned_by_profile(uuid, uuid);
  END IF;
END
$authz$;

DO $tx$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS ptx_has_beneficiary_entry ON public.payment_transactions;
    ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS ptx_cause_kind_known;
    ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS ptx_subject_kind_known;
    ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS ptx_attribution_version_shape;
  END IF;
END
$tx$;
DROP FUNCTION IF EXISTS public.payment_transaction_beneficiary_is_party();

DELETE FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled' AND enabled = FALSE;

DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3823_payment_attribution_and_scoped_reads.sql';
  END IF;
END
$ledger$;

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.payment_party_ledger(jsonb)') IS NOT NULL
     OR to_regprocedure('public.payment_party_remove_identity(jsonb)') IS NOT NULL
     OR to_regclass('public.payment_retention_settings') IS NOT NULL
     OR to_regprocedure('public.payment_transaction_beneficiary_is_party()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3823 rollback): an object survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'payment_ledger_reads_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3823 rollback): the flag row is still present.';
  END IF;
END $post$;
