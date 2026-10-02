-- Rollback for 3436_trail_health_snapshot_provenance.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3436 DID
-- =============
-- Added two nullable columns to public.trail_health_snapshots: feature_version
-- (text) and source_window (jsonb). Nothing else.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the two columns and deletes 3436's schema_migration_ledger row. No row is
-- deleted. The writer needs no redeploy: its next insert answers 42703, it
-- latches, and it writes the five 2910 columns exactly as before 3436. What it
-- gives up: a stored snapshot no longer says what window and feature version its
-- metrics were computed over (census-discovery DC-17, §75;
-- src/test/db/trailHealthSnapshotProvenance.db.test.ts goes red).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.trail_health_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3436 rollback): public.trail_health_snapshots does not exist.';
  END IF;
END $$;

ALTER TABLE public.trail_health_snapshots DROP COLUMN IF EXISTS source_window;
ALTER TABLE public.trail_health_snapshots DROP COLUMN IF EXISTS feature_version;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3436_trail_health_snapshot_provenance.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots'
                AND column_name IN ('feature_version', 'source_window')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3436 rollback): a 3436 column still exists on trail_health_snapshots.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots'
     AND column_name IN ('trail_id', 'metrics', 'model_version', 'member_count', 'captured_at')
  HAVING count(*) = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3436 rollback): a 2910 column of trail_health_snapshots is missing.';
  END IF;
END $post$;
