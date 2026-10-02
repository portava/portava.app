-- Rollback for 2894_rank_events_trip_add_outcome.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2894 DID
-- =============
-- Widened rank_events_outcome_check from 2297's eight to nine ('trip_add').
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- The footer's manual reversal DELETEs every 'trip_add' row. This file does not:
-- those rows are recorded travel intent, so it REFUSES while any exists (deleting
-- them is a retention decision). It refuses unless the CHECK is exactly 2894's
-- nine. Then it restores 2297's eight and deletes 2894's ledger row.

BEGIN;

DO $pre$
DECLARE v_def text; n bigint;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_outcome_check';
  IF v_def IS NULL OR v_def NOT LIKE '%trip_add%' OR v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2894): rank_events_outcome_check is not 2894''s nine: %', v_def;
  END IF;
  SELECT count(*) INTO n FROM public.rank_events WHERE outcome = 'trip_add';
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2894): % rank_events row(s) record a trip_add. Deleting recorded travel intent is a retention decision, not a rollback. Nothing has been changed.', n;
  END IF;
END
$pre$;

ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_outcome_check;
ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_outcome_check
  CHECK (outcome IN ('impression','tap','save','join','rsvp','attended','analytics','dismiss'));

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2894_rank_events_trip_add_outcome.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_outcome_check';
  IF v_def IS NULL OR v_def LIKE '%trip_add%' OR v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894 rollback): the outcome CHECK is not 2297''s eight: %', v_def;
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2894_rank_events_trip_add_outcome.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2894 rollback): the ledger still records 2894 as applied.';
  END IF;
END $post$;
