-- Rollback for 2893_rank_events_retire_writerless_surfaces.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2893 DID
-- =============
-- Narrowed rank_events_surface_check from the post-2298 fifteen to eight, and set
-- a COMMENT on rank_events.surface (the column carried none before: no earlier
-- migration and not the baseline comments it).
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Re-widens the CHECK to the post-2298 fifteen (2893's own REVERSIBLE BY block),
-- removes 2893's column comment, and deletes 2893's ledger row. Widening can never
-- fail on an existing row and deletes nothing. It refuses unless the CHECK is
-- exactly 2893's eight, so it can never widen some other vocabulary.
-- What no rollback restores (2893's header): any row a writer for a retired label
-- tried to write while the narrowed CHECK was in force. Those were rejected and
-- are gone.

BEGIN;

DO $pre$
DECLARE def text; live text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_surface_check';
  SELECT array_agg(m[1] ORDER BY m[1]) INTO live FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  IF live IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[
       'pulse','discovery','events','compass','live_pulse','living_page','watch_feed','wall']) x) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2893): rank_events_surface_check is not 2893''s eight, so this file will not re-widen it. Live definition: %', def;
  END IF;
END
$pre$;

ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
  CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search','nearby','story','event','trip','profile','explore','live_pulse','living_page','watch_feed','wall']::text[]));
COMMENT ON COLUMN public.rank_events.surface IS NULL;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2893_rank_events_retire_writerless_surfaces.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE def text; live text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
   WHERE c.conrelid = 'public.rank_events'::regclass AND c.conname = 'rank_events_surface_check';
  SELECT array_agg(m[1] ORDER BY m[1]) INTO live FROM regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') AS m;
  IF live IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['pulse','discovery','events','compass','search','nearby','story','event','trip','profile','explore','live_pulse','living_page','watch_feed','wall']) x) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893 rollback): the surface CHECK is not the post-2298 fifteen: %', def;
  END IF;
  IF col_description('public.rank_events'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.rank_events'::regclass AND attname = 'surface')) IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893 rollback): rank_events.surface still carries 2893''s comment.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2893_rank_events_retire_writerless_surfaces.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2893 rollback): the ledger still records 2893 as applied.';
  END IF;
END $post$;
