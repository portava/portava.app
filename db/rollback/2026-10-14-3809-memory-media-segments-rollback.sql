-- Rollback for artifacts/api-server/src/migrations/3809_memory_media_segments.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3809 DID: created public.memory_media_segments (logical windows over a
-- Memory video item's OWN stored object, with an optional owner label), its two
-- indexes, and the BEFORE INSERT OR UPDATE integrity trigger with its function.
-- It changed nothing on any existing table and wrote no storage object.
--
-- WHAT THIS ROLLBACK DOES: drops the trigger, the function and the table — ONLY
-- while the table is empty. A row is something an owner marked and named on
-- their own video; dropping it silently would delete their work. No byte of
-- media goes with it (a segment never held one), so nothing else needs undoing.
-- Check first:
--
--     SELECT count(*), count(DISTINCT owner_id) FROM public.memory_media_segments;
--
-- The emptiness check is a nested IF, not `to_regclass(...) IS NOT NULL AND
-- EXISTS (SELECT ... FROM t)`: PostgreSQL plans that whole expression, so on a
-- second run (table already gone) it would fail with 42P01 instead of no-op'ing.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.memory_media_segments') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_media_segments) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3809): memory_media_segments holds segments owners marked on their videos. Dropping them deletes that work. Decide what happens to them first.';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS memory_media_segments_integrity ON public.memory_media_segments;
DROP TABLE IF EXISTS public.memory_media_segments;
DROP FUNCTION IF EXISTS public.memory_media_segments_integrity();

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3809_memory_media_segments.sql';
  END IF;
END $$;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_media_segments') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809 rollback): memory_media_segments still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'memory_media_segments_integrity' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3809 rollback): memory_media_segments_integrity() still exists';
  END IF;
END $post$;
