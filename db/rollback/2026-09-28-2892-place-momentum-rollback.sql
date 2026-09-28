-- Rollback for 2892_place_momentum.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2892 DID
-- =============
-- Created public.place_momentum (15 columns, three indexes, RLS on, service_role
-- only), public.place_momentum_classify(4 × double precision) and
-- public.rebuild_place_momentum(timestamptz). Its header's REVERSIBLE BY block is
-- the three DROPs below.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- Refuses while a later file that builds on the projection is applied: 3410,
-- 3435 or 3476 (a column outside 2892's fifteen), 3476 (public.area_momentum),
-- 3477 (public.rebuild_place_momentum_v). Roll those back first, newest first.
-- Refuses while place_momentum holds ANY row. The rows are derived and 2892's
-- header calls them rederivable from rank_events, but whether their source rows
-- still exist is a retention fact this file cannot check; so an operator who
-- accepts that deletes them deliberately (DELETE FROM public.place_momentum) and
-- re-runs this file. In production P0 ships the table empty and nothing
-- schedules the rebuild (3475's scheduler flag is FALSE).
-- Then it drops the two functions and the table, and deletes 2892's ledger row.

BEGIN;

DO $pre$
DECLARE extra text; n bigint;
BEGIN
  IF to_regclass('public.place_momentum') IS NULL THEN
    RAISE NOTICE '2892 rollback: public.place_momentum is absent; only the functions and the ledger row are removed.';
  ELSE
    SELECT string_agg(column_name::text, ', ' ORDER BY column_name) INTO extra
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'place_momentum'
       AND column_name NOT IN ('id','place_id','computed_at','recent_rate','mid_rate','prior_rate','total_weight',
                               'trend_state','reason','model_version','event_weights','window_ms','thresholds',
                               'source_table','created_at');
    IF extra IS NOT NULL THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2892): place_momentum carries column(s) a later file added (%): 3410, 3435 or 3476 is applied. Roll those back first.', extra;
    END IF;
    EXECUTE 'SELECT count(*) FROM public.place_momentum' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2892): place_momentum holds % row(s). They are derived, but whether their rank_events source still exists is a retention fact; delete them deliberately (DELETE FROM public.place_momentum) and re-run this file.', n;
    END IF;
  END IF;
  IF to_regclass('public.area_momentum') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2892): public.area_momentum exists, so 3476 is applied. Roll 3477 and 3476 back first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rebuild_place_momentum_v') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2892): rebuild_place_momentum_v exists, so 3477 is applied. Roll it back first.';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.rebuild_place_momentum(timestamptz);
DROP FUNCTION IF EXISTS public.place_momentum_classify(double precision, double precision, double precision, double precision);
DROP TABLE IF EXISTS public.place_momentum;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2892_place_momentum.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.place_momentum') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892 rollback): public.place_momentum still exists.';
  END IF;
  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.place_momentum_classify(double precision,double precision,double precision,double precision)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892 rollback): a 2892 function still exists.';
  END IF;
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892 rollback): rank_events, the source, is gone.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2892_place_momentum.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2892 rollback): the ledger still records 2892 as applied.';
  END IF;
END $post$;
