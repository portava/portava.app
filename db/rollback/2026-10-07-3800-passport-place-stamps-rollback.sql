-- Rollback for 3800_passport_place_stamps.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3800 DID: rebuilt passport_stamps_dedup_idx PARTIAL (stamp_type <> 'place'),
-- added passport_stamps_place_dedup_idx (user_id, place_id) WHERE stamp_type = 'place',
-- added CHECK passport_stamps_place_has_place_id, seeded passport_place_stamps_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is TRUE, and refuses while any
-- Place stamp exists (the full dedup index would collide on two venues in one
-- city — restoring it would lose stamps, which is data loss, not a rollback).
-- Otherwise restores the full index — with the SAME column list 3800 found (the
-- plain or the COALESCE form), by stripping the 'place' predicate it added —
-- and removes what 3800 added.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'passport_place_stamps_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3800): passport_place_stamps_enabled is TRUE. Turn it off deliberately first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.passport_stamps WHERE stamp_type = 'place') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3800): Place stamps exist. Restoring the full dedup index would collide; go forward instead.';
  END IF;
END $$;

DROP INDEX IF EXISTS public.passport_stamps_place_dedup_idx;
ALTER TABLE public.passport_stamps DROP CONSTRAINT IF EXISTS passport_stamps_place_has_place_id;
DO $restore$
DECLARE
  def  text := pg_get_indexdef('public.passport_stamps_dedup_idx'::regclass);
  cols text;
BEGIN
  IF def = 'CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public.passport_stamps USING btree (user_id, stamp_type, country, city) WHERE (stamp_type <> ''place''::text)' THEN
    cols := '(user_id, stamp_type, country, city)';
  ELSIF def = 'CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public.passport_stamps USING btree (user_id, stamp_type, COALESCE(country, ''''::text), COALESCE(city, ''''::text)) WHERE (stamp_type <> ''place''::text)' THEN
    cols := '(user_id, stamp_type, COALESCE(country, ''''::text), COALESCE(city, ''''::text))';
  ELSE
    RAISE EXCEPTION 'ROLLBACK REFUSED (3800): passport_stamps_dedup_idx is "%", not a form 3800 writes; restore it by hand.', def;
  END IF;
  EXECUTE 'DROP INDEX public.passport_stamps_dedup_idx';
  EXECUTE 'CREATE UNIQUE INDEX passport_stamps_dedup_idx ON public.passport_stamps USING btree ' || cols;
END $restore$;
DELETE FROM public.feature_flags WHERE flag = 'passport_place_stamps_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3800_passport_place_stamps.sql';

COMMIT;
