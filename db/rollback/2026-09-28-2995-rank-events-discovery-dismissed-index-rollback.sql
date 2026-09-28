-- Rollback for 2995_rank_events_discovery_dismissed_index.sql
-- Written by lane W11-S (census-discovery §97, register D-W11S-2), 2026-09-28.
-- Rehearsed on the local PostgreSQL 16 harness only (apply, rollback, re-apply,
-- catalogue diff against a no-apply baseline; docs/ops/discovery-portava-ci-apply-plan.md §9).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2995 DID
-- =============
-- Created the partial index public.rank_events_discovery_dismissed. Nothing else.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the index (its footer's reversal) and deletes 2995's ledger row. No row
-- changes; the dismissed-place read gets slower, not wrong.

BEGIN;

DROP INDEX IF EXISTS public.rank_events_discovery_dismissed;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2995_rank_events_discovery_dismissed_index.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF to_regclass('public.rank_events_discovery_dismissed') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2995 rollback): rank_events_discovery_dismissed still exists.';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('rank_events_features_gin', 'rank_events_user_served_at', 'rank_events_user_item')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2995 rollback): one of 0153''s three rank_events indexes is missing.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2995_rank_events_discovery_dismissed_index.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2995 rollback): the ledger still records 2995 as applied.';
  END IF;
END $post$;
