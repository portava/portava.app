-- Rollback for 3387_creator_ledger_integrity_and_audit.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3387 DID
-- =============
--   * Replaced creator_earning_entries' attribution_id and beneficiary_user_id
--     foreign keys with cee_attribution_fk / cee_beneficiary_fk ... ON DELETE CASCADE.
--   * CREATE FUNCTION public.creator_ledger_lock_attribution(uuid).
--   * Triggers + functions: ca_rule_version_is_published,
--     ca_supersession_is_lawful (creator_attributions), cee_attribution_is_current,
--     the deferred constraint trigger cee_transaction_balances
--     (creator_earning_entries).
--   * CREATE TABLE public.creator_ledger_audit_events (+ indexes, trigger
--     clae_no_update, RLS, service_role INSERT/SELECT/DELETE).
--   * CREATE FUNCTION public.creator_ledger_append(jsonb), EXECUTE for
--     service_role only.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops all of the above and restores 2921's two foreign keys exactly: the
-- attribution_id FK WITHOUT ON DELETE and the beneficiary_user_id FK ON DELETE
-- SET NULL — which together re-block account erasure for any creator with an
-- earning; that is the defect 3387 fixed, restored exactly. Deletes 3387's
-- schema_migration_ledger row.
--
-- Roll this back BEFORE 3386.
--
-- ⚠ IT REFUSES WHILE THE AUDIT TABLE HOLDS ROWS. They are the only record of who
-- held, released, recomputed or reversed a creator's earning and why. Set
-- `rollback.force_drop_creator_ledger_audit` to 'on' in the same session to drop
-- them deliberately.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.creator_ledger_audit_events') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.creator_ledger_audit_events;
    IF n > 0 AND coalesce(current_setting('rollback.force_drop_creator_ledger_audit', true), '') <> 'on' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3387): public.creator_ledger_audit_events holds % row(s), the only record of those holds, releases and recomputations. Set rollback.force_drop_creator_ledger_audit = on to drop them deliberately.', n;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.creator_ledger_append(jsonb);
DROP TABLE IF EXISTS public.creator_ledger_audit_events;

DROP TRIGGER IF EXISTS cee_transaction_balances ON public.creator_earning_entries;
DROP FUNCTION IF EXISTS public.creator_earning_transaction_balances();
DROP TRIGGER IF EXISTS cee_attribution_is_current ON public.creator_earning_entries;
DROP FUNCTION IF EXISTS public.creator_earning_attribution_is_current();
DROP TRIGGER IF EXISTS ca_supersession_is_lawful ON public.creator_attributions;
DROP FUNCTION IF EXISTS public.creator_attribution_supersession_is_lawful();
DROP TRIGGER IF EXISTS ca_rule_version_is_published ON public.creator_attributions;
DROP FUNCTION IF EXISTS public.creator_attribution_rule_version_is_published();
DROP FUNCTION IF EXISTS public.creator_ledger_lock_attribution(uuid);

ALTER TABLE public.creator_earning_entries DROP CONSTRAINT IF EXISTS cee_attribution_fk;
ALTER TABLE public.creator_earning_entries DROP CONSTRAINT IF EXISTS cee_beneficiary_fk;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
       AND confrelid = 'public.creator_attributions'::regclass
  ) THEN
    ALTER TABLE public.creator_earning_entries
      ADD CONSTRAINT creator_earning_entries_attribution_id_fkey
      FOREIGN KEY (attribution_id) REFERENCES public.creator_attributions(id);
  END IF;
  -- 2921's shape, restored exactly — including the SET NULL that an append-only
  -- table refuses, which is the second half of what 3387 fixed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
       AND confrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.creator_earning_entries
      ADD CONSTRAINT creator_earning_entries_beneficiary_user_id_fkey
      FOREIGN KEY (beneficiary_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3387_creator_ledger_integrity_and_audit.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.creator_ledger_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3387 rollback): the audit table still exists';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('ca_rule_version_is_published', 'ca_supersession_is_lawful',
                                         'cee_attribution_is_current', 'cee_transaction_balances');
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3387 rollback): % trigger(s) remain', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
     AND confrelid = 'public.creator_attributions'::regclass AND confdeltype = 'a';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3387 rollback): 2921''s NO ACTION foreign key was not restored'; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
     AND confrelid = 'public.profiles'::regclass AND confdeltype = 'n';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3387 rollback): 2921''s SET NULL beneficiary foreign key was not restored'; END IF;
END
$post$;
