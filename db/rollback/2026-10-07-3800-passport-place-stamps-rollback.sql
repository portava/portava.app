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
-- Otherwise restores the full index and removes what 3800 added.

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
DROP INDEX IF EXISTS public.passport_stamps_dedup_idx;
CREATE UNIQUE INDEX passport_stamps_dedup_idx
  ON public.passport_stamps USING btree (user_id, stamp_type, country, city);
DELETE FROM public.feature_flags WHERE flag = 'passport_place_stamps_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3800_passport_place_stamps.sql';

COMMIT;
