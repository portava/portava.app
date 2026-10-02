-- Rollback for 2297_rank_events_dismiss_outcome.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2297 DID
-- =============
--   * rank_events_outcome_check widened from 0197's seven to eight ('dismiss').
--   * created public.record_distribution_negative_signal(text, text, integer,
--     double precision), SECURITY DEFINER, EXECUTE for service_role only. No
--     earlier file defines it, so dropping it restores the pre-2297 catalogue.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- The footer's manual reversal DELETEs every 'dismiss' row first. This file does
-- NOT: those rows are recorded user feedback ("Not interested"), so it REFUSES
-- while any exists, and deleting them is the owner's retention decision, not a
-- rollback. It also refuses unless the CHECK is exactly 2297's eight (2894 adds
-- 'trip_add': roll 2894 back first) and while 2995's partial index over the
-- dismiss rows exists (roll 2995 back first). Then it restores 0197's seven,
-- drops the function, and deletes 2297's ledger row.

BEGIN;

DO $pre$
DECLARE v_def text; n bigint;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_outcome_check';
  IF v_def IS NULL OR v_def NOT LIKE '%dismiss%' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2297): rank_events_outcome_check does not carry 2297''s ''dismiss'' (%). Nothing to reverse, or not 2297''s state.', v_def;
  END IF;
  IF v_def LIKE '%trip_add%' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2297): the outcome CHECK also admits trip_add, so 2894 is applied. Roll 2894 back first (newest first).';
  END IF;
  IF to_regclass('public.rank_events_discovery_dismissed') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2297): 2995''s index rank_events_discovery_dismissed exists. Roll 2995 back first (newest first).';
  END IF;
  SELECT count(*) INTO n FROM public.rank_events WHERE outcome = 'dismiss';
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2297): % rank_events row(s) record a dismiss. The narrowed CHECK cannot hold them, and deleting recorded user feedback is a retention decision, not a rollback. Nothing has been changed.', n;
  END IF;
END
$pre$;

ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_outcome_check;
ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_outcome_check
  CHECK (outcome IN ('impression','tap','save','join','rsvp','attended','analytics'));

DROP FUNCTION IF EXISTS public.record_distribution_negative_signal(text, text, integer, double precision);

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2297_rank_events_dismiss_outcome.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_outcome_check';
  IF v_def IS NULL OR v_def LIKE '%dismiss%' OR v_def NOT LIKE '%analytics%' OR v_def NOT LIKE '%impression%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2297 rollback): the outcome CHECK is not 0197''s seven: %', v_def;
  END IF;
  IF to_regprocedure('public.record_distribution_negative_signal(text,text,integer,double precision)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2297 rollback): record_distribution_negative_signal still exists.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2297_rank_events_dismiss_outcome.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2297 rollback): the ledger still records 2297 as applied.';
  END IF;
END $post$;
