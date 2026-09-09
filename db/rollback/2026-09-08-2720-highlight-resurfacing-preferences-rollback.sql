-- Rollback for 2720_highlight_resurfacing_preferences.sql
--
-- Applied to portava-ci (hwokxgbmezheskbzskfr) 2026-09-08 as version
-- 20260908151339. NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- The forward file names this exact statement as its inverse and says the read
-- code returns to `absent`, clamping nothing. That is the property that makes
-- the DROP recoverable: highlightResurfacing.ts distinguishes an ABSENT table
-- (report, do not enforce) from an UNREADABLE one (fail closed), so removing the
-- table restores the pre-migration surface rather than suppressing everything.
--
-- WHAT THE DROP DESTROYS, stated because it is not nothing: every row here is a
-- user's stated wish not to see something. Dropping the table does not fail
-- closed — it makes hidden people and hidden trips resurface. Roll this back
-- only while the table is empty, or after exporting it.

BEGIN;

DROP TABLE IF EXISTS public.highlight_resurfacing_preferences;

DO $$
DECLARE leftover_relations INTEGER; leftover_policies INTEGER; profiles_present BOOLEAN;
BEGIN
  SELECT count(*) INTO leftover_relations
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'highlight\_resurfacing%';
  IF leftover_relations <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % relation(s) named by 2720 survive', leftover_relations;
  END IF;

  SELECT count(*) INTO leftover_policies FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'highlight_resurfacing_preferences';
  IF leftover_policies <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: % policy row(s) survive', leftover_policies;
  END IF;

  -- The FK target must survive the DROP of the referencing table. Asserted
  -- because a rollback that took public.profiles with it would be catastrophic
  -- and silent in a rehearsal that only counted the table it meant to remove.
  SELECT to_regclass('public.profiles') IS NOT NULL INTO profiles_present;
  IF NOT profiles_present THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.profiles is gone -- 2720 referenced it, it did not create it';
  END IF;
END $$;

COMMIT;
