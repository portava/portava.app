-- Rollback for 3376_discovery_recommendations_per_request.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3376 DID
-- =============
--   * CREATE TABLE public.recommendations (one row per served Discovery
--     request), two indexes, RLS on, service_role SELECT + INSERT only, two
--     service_role policies, comments.
--   * CREATE FUNCTION public.record_discovery_serve_request(jsonb), SECURITY
--     INVOKER, EXECUTE for service_role only.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the function and the table (its indexes, policies and grants go with
-- it) and deletes
-- 3376's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3376.
--
-- ⚠ IT REFUSES WHILE THE TABLE HOLDS ROWS. Once lib/discoveryServeLog.ts has
-- written to it, this table is the ONLY record of every anonymous Discovery
-- serve, and dropping it destroys data that exists nowhere else. Set
-- `rollback.force_drop_recommendations` to 'on' in the same session to drop a
-- populated table deliberately; nothing else overrides the refusal. The writer
-- degrades on its own when the table is absent (it latches, warns once and
-- stops trying), so dropping it never breaks a serve.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.recommendations') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.recommendations;
    IF n > 0 AND coalesce(current_setting('rollback.force_drop_recommendations', true), '') <> 'on' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3376): public.recommendations holds % row(s), the only record of those serves. Set rollback.force_drop_recommendations = on to drop them deliberately.', n;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.record_discovery_serve_request(jsonb);
DROP TABLE IF EXISTS public.recommendations;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3376_discovery_recommendations_per_request.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.recommendations') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376 rollback): public.recommendations still exists.';
  END IF;
  IF to_regprocedure('public.record_discovery_serve_request(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376 rollback): record_discovery_serve_request still exists.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3376_discovery_recommendations_per_request.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3376 rollback): the ledger still records 3376 as applied.';
  END IF;
END $post$;
