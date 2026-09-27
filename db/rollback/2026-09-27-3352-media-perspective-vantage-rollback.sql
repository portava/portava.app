-- Rollback for 3352_media_perspective_vantage.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3352 DID
-- =============
--   * ALTER TABLE public.posts ADD COLUMN perspective_vantage text NULL, and the
--     CHECK constraint posts_perspective_vantage_check over §12's vocabularies.
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_perspective_vantage_enabled', false, '<description>')
--
-- WHAT THIS ROLLBACK DOES
-- =======================
--   1. REFUSES while the flag reads TRUE: the owner has offered vantages since
--      3352 was applied. Turn it off deliberately first.
--   2. REFUSES while any post carries a vantage. Dropping the column would
--      delete what contributors chose, and it is theirs. The operator decides
--      (e.g. `UPDATE public.posts SET perspective_vantage = NULL WHERE
--      perspective_vantage IS NOT NULL;` after telling the product owner). With
--      no vantage stored and the flag off, nothing reads or writes the column.
--   3. Deletes the flag row (only while FALSE), drops the CHECK, drops the column.
--
-- ORDER MATTERS: code from this lane reads the column only while the flag is
-- on, and code from before it never names the column, so once step 1 has
-- passed no running server can be mid-read of a column this script drops.

BEGIN;

DO $$
DECLARE on_count int; carrying bigint;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_perspective_vantage_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_perspective_vantage_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'perspective_vantage'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.posts WHERE perspective_vantage IS NOT NULL' INTO carrying;
    IF carrying <> 0 THEN
      RAISE EXCEPTION
        'ROLLBACK REFUSED: % post(s) carry a contributor-declared perspective_vantage. Dropping the column deletes their choice; decide first (see this file''s header).', carrying;
    END IF;
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'media_perspective_vantage_enabled' AND enabled = FALSE;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_perspective_vantage_check;
ALTER TABLE public.posts DROP COLUMN IF EXISTS perspective_vantage;

DO $$
DECLARE present int; col int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_perspective_vantage_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_perspective_vantage_enabled still present after rollback (% row(s))', present;
  END IF;
  SELECT count(*) INTO col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'perspective_vantage';
  IF col <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: posts.perspective_vantage still present after rollback';
  END IF;
END $$;

COMMIT;
