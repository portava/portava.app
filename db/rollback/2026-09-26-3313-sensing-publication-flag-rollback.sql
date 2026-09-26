-- Rollback for 3313_sensing_publication_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3313 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('sensing_publication_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has enabled the publisher since 3313 was applied; deleting the row
-- would silently turn it off (an absent row reads false), which is a product
-- change made by a script. It raises instead and the operator decides.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'sensing_publication_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: sensing_publication_enabled is TRUE. The owner has enabled the publisher since 3313 was applied; deleting the row would silently disable a live capability. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'sensing_publication_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'sensing_publication_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_publication_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
