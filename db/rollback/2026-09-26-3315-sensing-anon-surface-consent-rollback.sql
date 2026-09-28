-- Rollback for 3315_sensing_anon_surface_consent.sql
--
-- WHAT 3315 DID: ADD COLUMN sensing_anon_contributions.surface_permitted
-- boolean NOT NULL DEFAULT false.
--
-- WHAT THIS DOES, AND WHAT IT REFUSES
-- Drops the column — but only while NO row reads true. With one present, the
-- publisher (which filters on the column) would start failing its cohort read
-- and withhold everything, and — worse — code rolled back past the publisher's
-- filter would aggregate consenting and non-consenting contributions together.
-- So it raises, and the operator first turns publication off
-- (sensing_publication_enabled = false) and decides what to do with those rows.
-- Idempotent once it proceeds.

BEGIN;

DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.sensing_anon_contributions') IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sensing_anon_contributions' AND column_name = 'surface_permitted';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.sensing_anon_contributions WHERE surface_permitted' INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % contribution(s) carry surface consent. Turn publication off first, then decide their fate deliberately.', n;
  END IF;
END $$;

ALTER TABLE public.sensing_anon_contributions DROP COLUMN IF EXISTS surface_permitted;

COMMIT;
-- Then: DELETE FROM public.schema_migration_ledger WHERE filename = '3315_sensing_anon_surface_consent.sql';
