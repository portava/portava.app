-- Rollback for 3501_discovery_recommendations_retention.sql
--
-- WHAT 3501 DID
-- =============
--   * CREATE INDEX public.recommendations_created_at (created_at).
--   * INSERT feature_flags 'discovery_serve_log_retention_enabled' (TRUE,
--     metadata.keep_days = 30, labelled a TESTING retention period).
--   * CREATE FUNCTION public.discovery_recommendations_retention_cutoff()
--     (INVOKER) and public.purge_expired_discovery_recommendations(integer)
--     (DEFINER), service_role EXECUTE only.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops both functions, the index and the flag row, and deletes 3501's
-- schema_migration_ledger row so a later run of scripts/src/apply-migrations.ts
-- re-applies it. It deletes NO row of public.recommendations: rows the purge
-- already removed are gone (that was the point), and the rows still present
-- stay. lib/discoveryServeLogRetentionScheduler.ts then reports every tick as a
-- failure (the flag row is absent), which is the honest reading.
--
-- ⚠ IT REFUSES WHILE discovery_serve_log_enabled IS ON. The owner's decision
-- (census-discovery §120) was logging and cleanup TOGETHER; removing the cleanup
-- while the logging runs recreates the state that decision ruled out — rows
-- accumulating with no bound. Turn the logging off first, or set
-- `rollback.allow_unbounded_serve_log` to 'on' in the same session to roll back
-- deliberately anyway.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_serve_log_enabled' AND enabled)
     AND coalesce(current_setting('rollback.allow_unbounded_serve_log', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3501): discovery_serve_log_enabled is ON; removing the retention would leave public.recommendations growing with no bound (census-discovery §120). Turn the logging off first, or set rollback.allow_unbounded_serve_log = on.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.purge_expired_discovery_recommendations(integer);
DROP FUNCTION IF EXISTS public.discovery_recommendations_retention_cutoff();
DROP INDEX IF EXISTS public.recommendations_created_at;
DELETE FROM public.feature_flags WHERE flag = 'discovery_serve_log_retention_enabled';

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3501_discovery_recommendations_retention.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.purge_expired_discovery_recommendations(integer)') IS NOT NULL
     OR to_regprocedure('public.discovery_recommendations_retention_cutoff()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501 rollback): a retention function survived.';
  END IF;
  IF to_regclass('public.recommendations_created_at') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501 rollback): recommendations_created_at survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'discovery_serve_log_retention_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501 rollback): the retention flag row survived.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3501_discovery_recommendations_retention.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3501 rollback): the ledger still records 3501 as applied.';
  END IF;
END $post$;
