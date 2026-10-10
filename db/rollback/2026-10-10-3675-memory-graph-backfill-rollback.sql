-- Rollback for 3675_memory_graph_backfill.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3675 DID: ran 3674's memory_graph_backfill_legacy to completion, writing
-- one LEGACY_IMPORTED memory_relations row per live Memory's trip / event /
-- place and per approved tag.
-- WHAT THIS ROLLBACK DOES: deletes every LEGACY_IMPORTED edge. Nothing is lost:
-- each one is derived from memories + memory_tags and is re-derived by
-- re-running the backfill. USER_CREATED edges (split lineage) are NOT touched.
-- NOTE: while 3674 is applied its triggers re-create an edge on the next write
-- to that Memory; to remove the mirror itself, roll back 3674.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_relations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'memory_relations' AND column_name = 'source_mode') THEN
    EXECUTE 'DELETE FROM public.memory_relations WHERE source_mode = ''LEGACY_IMPORTED''';
  END IF;
END $$;
DELETE FROM public.schema_migration_ledger WHERE filename = '3675_memory_graph_backfill.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_relations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'memory_relations' AND column_name = 'source_mode') THEN
    IF EXISTS (SELECT 1 FROM public.memory_relations WHERE source_mode = 'LEGACY_IMPORTED') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3675 rollback): LEGACY_IMPORTED edges remain';
    END IF;
  END IF;
END $post$;
