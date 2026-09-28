-- 3436_trail_health_snapshot_provenance.sql
-- Trail health keeps its provenance (census-discovery DC-17, §75, lane P33, H-P21-3).
--
-- `10` §5: "Derived features must retain: source event window · feature version ·
-- model version · computation time". A `trail_health_snapshots` row (2910)
-- retained two:
--   model version        model_version = 'trail-health-v1' (2910)
--   computation time     captured_at (2910; since §75 the computation clock the
--                        health carries, not the write clock)
-- and NOT the other two. This file adds them, as two NULLABLE columns:
--   feature_version text   what one input row contributed — lib/discoveryTrailHealth
--                          TRAIL_HEALTH_FEATURE_VERSION ('trail-member-rows-v1')
--   source_window  jsonb   {"kind","start","end"}: members of any age, so
--                          kind 'unbounded_start', start null, end = the clock
--
-- Columns only. No function, trigger, index, policy or grant changes; no row is
-- written, backfilled or deleted. ROWS WRITTEN BEFORE THIS FILE keep both NULL:
-- "not recorded", never a guess. The writer (services/trails/TrailService.ts
-- `insertTrailHealthSnapshotRow`) sends both columns and, on 42703 / PGRST204,
-- latches and writes the five pre-3436 columns exactly as before — so this file
-- may deploy before OR after the code, and neither order loses a snapshot.
--
-- `trail_health_snapshots` exists in production (2910 applied 2026-09-20, see
-- scripts/checkProductionDrift.ts). Two nullable columns without a default are a
-- catalogue-only change in PostgreSQL 11+: no table rewrite, no scan.
--
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- `10` §4: no query path changes; the snapshot's one read (the hourly skip)
-- selects `id` and filters on (trail_id, captured_at) through idx_trail_health_recent.
--
-- Rollback: db/rollback/2026-09-28-3436-trail-health-snapshot-provenance-rollback.sql
-- (drops the two columns; deletes no row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trail_health_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3436): public.trail_health_snapshots does not exist. Apply 2910_discovery_trails.sql first.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots'
     AND column_name IN ('trail_id', 'metrics', 'model_version', 'member_count', 'captured_at')
  HAVING count(*) = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3436): trail_health_snapshots is not 2910''s shape (trail_id, metrics, model_version, member_count, captured_at).';
  END IF;
END
$pre$;

ALTER TABLE public.trail_health_snapshots ADD COLUMN IF NOT EXISTS feature_version text;
ALTER TABLE public.trail_health_snapshots ADD COLUMN IF NOT EXISTS source_window jsonb;

COMMENT ON COLUMN public.trail_health_snapshots.feature_version IS
  '`10` §5 feature version (census-discovery DC-17, 3436): what one content_trails member '
  'and the open-report count contributed to the nine metrics (lib/discoveryTrailHealth '
  'TRAIL_HEALTH_FEATURE_VERSION). NULL on rows written before 3436, which recorded none.';
COMMENT ON COLUMN public.trail_health_snapshots.source_window IS
  '`10` §5 source event window (census-discovery DC-17, 3436): {"kind","start","end"} — '
  'members of any age count, so kind is unbounded_start, start null, end the computation '
  'clock. NULL on rows written before 3436, which recorded none.';

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots'
     AND column_name = 'feature_version' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3436): trail_health_snapshots.feature_version (text, nullable, no default) is missing.';
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'trail_health_snapshots'
     AND column_name = 'source_window' AND data_type = 'jsonb' AND is_nullable = 'YES' AND column_default IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3436): trail_health_snapshots.source_window (jsonb, nullable, no default) is missing.';
  END IF;
END
$post$;
