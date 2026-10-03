-- Rollback for 3510_creator_ledger_erasure_policy_undecided.sql
-- Written 2026-09-30 by the creator-ledger lane (census-discovery §107).
-- Rehearsed on the local PostgreSQL 16 harness only (apply, re-apply, rollback,
-- re-apply; src/test/db/creatorLedgerErasurePolicy.db.test.ts G6).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3510 DID
-- =============
-- (1) Replaced rent_buddy_earnings_entries' beneficiary key (2901, ON DELETE
--     SET NULL) with rbee_beneficiary_fk ON DELETE CASCADE.
-- (2) Added public.creator_ledger_erasure_policy_undecided() and a row-level
--     BEFORE DELETE trigger calling it on the four ledger tables.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- It REFUSES while any of the four tables holds a row. Removing the guard then
-- would hand those rows to 3387's cascade (and to the booking cascade), i.e.
-- choose "delete on erasure" for them by default — the decision C-11 leaves
-- to the owner. It also refuses while a C-11 answer (3511 or 3512) is applied:
-- roll that back first, and it re-installs this guard.
-- With all four tables empty it drops the four triggers and the function,
-- restores 2901's key EXACTLY as 2901 wrote it (ON DELETE SET NULL — which
-- restores the defect of census §52.2 item 3, on purpose: a rollback returns
-- to the prior schema, it does not improve it), and deletes 3510's ledger row.

BEGIN;

DO $pre$
DECLARE n bigint; t text;
BEGIN
  IF to_regprocedure('public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.creator_ledger_remove_identity(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3510): a C-11 answer (3511 or 3512) is applied. Roll it back first.';
  END IF;
  FOREACH t IN ARRAY ARRAY['rent_buddy_earnings_entries', 'creator_attributions',
                           'creator_earning_entries', 'creator_ledger_audit_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'ROLLBACK REFUSED (3510): % holds % row(s). Removing the erasure guard would let an erasure delete them, which is the C-11 decision, not a rollback. Nothing has been changed.', t, n;
      END IF;
    END IF;
  END LOOP;
END
$pre$;

DROP TRIGGER IF EXISTS rbee_erasure_policy_undecided ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_erasure_policy_undecided   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_erasure_policy_undecided  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_erasure_policy_undecided ON public.creator_ledger_audit_events;
DROP FUNCTION IF EXISTS public.creator_ledger_erasure_policy_undecided();

DO $fk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
                AND conname = 'rbee_beneficiary_fk') THEN
    ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT rbee_beneficiary_fk;
    ALTER TABLE public.rent_buddy_earnings_entries
      ADD CONSTRAINT rent_buddy_earnings_entries_beneficiary_user_id_fkey FOREIGN KEY (beneficiary_user_id)
      REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END
$fk$;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3510_creator_ledger_erasure_policy_undecided.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.creator_ledger_erasure_policy_undecided()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3510 rollback): the guard function still exists.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND contype = 'f'
                    AND confrelid = 'public.profiles'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3510 rollback): 2901''s ON DELETE SET NULL key was not restored.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3510_creator_ledger_erasure_policy_undecided.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3510 rollback): the ledger still records 3510 as applied.';
  END IF;
END $post$;
