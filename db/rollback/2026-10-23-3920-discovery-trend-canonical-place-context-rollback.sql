-- Rollback for 3920_discovery_trend_canonical_place_context.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3920 DID: created five functions no other migration defines
-- (discovery_trend_place_context_canonical, discovery_trend_windows_v2_canonical,
-- discovery_trend_post_groups_v2_canonical, rebuild_place_momentum_v2_canonical,
-- rebuild_place_momentum_canonical) and inserted
-- discovery_trend_canonical_place_context_enabled, FALSE. It changed no existing
-- function, table or row; 3988's five pinned functions were never touched.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is TRUE (the scheduler would
-- then call a function that no longer exists, and every tick would fail). With it
-- FALSE or absent it drops the five functions, deletes the FALSE row and 3920's
-- schema_migration_ledger row so the applier re-applies it. place_momentum /
-- area_momentum rows a canonical run already wrote stay: they are ordinary runs
-- under the trend retention (Q11(b)), and a newer run supersedes them.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trend_canonical_place_context_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3920): discovery_trend_canonical_place_context_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rebuild_place_momentum_canonical(timestamptz);
DROP FUNCTION IF EXISTS public.rebuild_place_momentum_v2_canonical(timestamptz);
DROP FUNCTION IF EXISTS public.discovery_trend_post_groups_v2_canonical(timestamptz);
DROP FUNCTION IF EXISTS public.discovery_trend_windows_v2_canonical(timestamptz, text);
DROP FUNCTION IF EXISTS public.discovery_trend_place_context_canonical();
DELETE FROM public.feature_flags WHERE flag = 'discovery_trend_canonical_place_context_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3920_discovery_trend_canonical_place_context.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regprocedure('public.rebuild_place_momentum_canonical(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.discovery_trend_place_context_canonical()') IS NOT NULL
     OR to_regprocedure('public.rebuild_place_momentum_v2_canonical(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.discovery_trend_windows_v2_canonical(timestamptz,text)') IS NOT NULL
     OR to_regprocedure('public.discovery_trend_post_groups_v2_canonical(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3920 rollback): a canonical trend function still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_trend_canonical_place_context_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3920 rollback): the flag is still present.';
  END IF;
  IF to_regprocedure('public.rebuild_place_momentum(timestamptz)') IS NULL OR to_regprocedure('public.discovery_trend_place_context()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3920 rollback): an original trend function is missing — this rollback must not touch them.';
  END IF;
END $post$;
