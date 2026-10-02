-- 3484_compass_city_confidence_provenance.sql
-- The city-confidence reading's provenance, and the flag that writes it
-- (census-discovery DC-17 / H-P21-4, §75.3 → §85, lane W10-R3).
--
-- `10` §5: "Derived features must retain: source event window · feature version ·
-- model version · computation time". A `compass_city_confidence` row retained ONE
-- (computed_at). §75.3 found the producer could not state a window at all — its
-- reads were `.limit(20000)` with no `order`, and a failed read scored a city as
-- empty. compass/cityConfidenceWindowedReads.ts reads the corpus ordered, paged
-- and windowed, surfaces read errors, and writes the three missing facts here.
--
-- This file adds THREE NULLABLE columns (no default, no backfill, no index) and
-- ONE capability flag seeded FALSE:
--   model_version     text   compass-city-depth-v1 (scoreCityDepth's arithmetic)
--   feature_version   text   compass-city-depth-signals-v1 (what one row contributes)
--   source_window     jsonb  {kind, startMs, endMs, truncated, rows}
--   compass_city_confidence_windowed_reads_enabled  — FALSE
--
-- WITH THE FLAG OFF NOTHING WRITES THE COLUMNS and the producer's upsert payload
-- is byte-identical to before (src/test/compassCityConfidenceWindow.test.ts W0).
-- Rows written before this file, or with the flag off, keep NULL: "not recorded",
-- never a guess (lib/discoveryCandidates/graphReadingProvenance.ts says
-- `not_recorded`). The columns and the flag ship in ONE file on purpose: the flag
-- must never be on where the columns are absent, or the producer's upsert would
-- answer 42703 and no city would be scored.
--
-- WITH THE FLAG ON `depth_score` MOVES for any city whose edges exceeded the old
-- unordered cap, and a failed read no longer writes a zero. That is a computed
-- value; turning the flag on in production is PRODUCTION ACTIVATION, the owner's
-- decision (docs/architecture/discovery-decision-register.md, D-W10-R3-9).
--
-- `compass_city_confidence` is created by 20260730_compass_intelligence_graph.sql.
-- Three nullable columns without a default are a catalogue-only change.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-R3 range
-- 3480-3484). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness.
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr).
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Rollback: db/rollback/2026-09-28-3484-compass-city-confidence-provenance-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.compass_city_confidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3484): public.compass_city_confidence does not exist. Apply 20260730_compass_intelligence_graph.sql first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3484): public.feature_flags does not exist.';
  END IF;
END
$pre$;

ALTER TABLE public.compass_city_confidence ADD COLUMN IF NOT EXISTS model_version text;
ALTER TABLE public.compass_city_confidence ADD COLUMN IF NOT EXISTS feature_version text;
ALTER TABLE public.compass_city_confidence ADD COLUMN IF NOT EXISTS source_window jsonb;

COMMENT ON COLUMN public.compass_city_confidence.model_version IS
  '`10` §5 model version (census-discovery DC-17, 3484): the scoreCityDepth arithmetic '
  'that computed depth_score. NULL on rows written before 3484 or with '
  'compass_city_confidence_windowed_reads_enabled off.';
COMMENT ON COLUMN public.compass_city_confidence.feature_version IS
  '`10` §5 feature version (3484): what one corpus row contributed to the signals. NULL: not recorded.';
COMMENT ON COLUMN public.compass_city_confidence.source_window IS
  '`10` §5 source event window (3484): {kind unbounded_start|bounded, startMs, endMs, '
  'truncated, rows}. endMs equals computed_at. NULL: not recorded.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'compass_city_confidence_windowed_reads_enabled',
    false,
    'Compass city-confidence producer reads (census-discovery DC-17 / H-P21-4, §85): ON: the corpus is read ordered, paged and windowed, a failed read scores no city, and each reading records model_version, feature_version and source_window (3484). depth_score moves for a city whose edges exceeded the old unordered 20000-row cap. OFF / absent / unreadable (the seed): the producer reads and writes exactly as before. Turning it on is an owner decision.'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE n int; on_count int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'compass_city_confidence'
     AND ((column_name = 'model_version' AND data_type = 'text')
       OR (column_name = 'feature_version' AND data_type = 'text')
       OR (column_name = 'source_window' AND data_type = 'jsonb'))
     AND is_nullable = 'YES' AND column_default IS NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3484): expected 3 nullable, default-free provenance columns, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.feature_flags WHERE flag = 'compass_city_confidence_windowed_reads_enabled';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3484): the flag row is missing.';
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
   WHERE flag = 'compass_city_confidence_windowed_reads_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3484): compass_city_confidence_windowed_reads_enabled is ON. It moves depth_score; enabling it is an owner decision and this file must ship it OFF.';
  END IF;
END $post$;
