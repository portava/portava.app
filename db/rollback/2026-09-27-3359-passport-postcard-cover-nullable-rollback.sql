-- Rollback for 3359_passport_postcard_cover_nullable.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3359 DID
-- =============
--   * ALTER TABLE public.passport_postcards ALTER COLUMN media_url DROP NOT NULL.
--     No row, default, grant or policy was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores NOT NULL, and ONLY while no row holds a NULL cover. A NULL cover
-- means the server found no file of that postcard's post that may be shown
-- (census-media §37.10 item 3). There is no truthful value to put back: the
-- previous cover was a held or removed file. So this raises instead of
-- inventing one, and the operator decides per row (for example: remove the
-- postcard from the passport, or wait until a file counts and the server fills
-- the cover).

BEGIN;

DO $$
DECLARE null_count int;
BEGIN
  SELECT count(*) INTO null_count FROM public.passport_postcards WHERE media_url IS NULL;
  IF null_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: % passport_postcards row(s) have no cover (media_url IS NULL). Restoring NOT NULL would need a value, and the only one available is a held or removed file. Resolve those rows deliberately first, then re-run this file.', null_count;
  END IF;
END $$;

ALTER TABLE public.passport_postcards ALTER COLUMN media_url SET NOT NULL;

COMMIT;
