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

-- Only the row 3352 wrote (W10-F, census-discovery §87). 3352 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3352's seed text byte for
-- byte (the md5 below) was not written by 3352, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_perspective_vantage_enabled' AND md5(coalesce(description, '')) <> '417dbcc7dd94fa6a15cff3f9e965bab6') THEN
    RAISE NOTICE '3352 rollback: media_perspective_vantage_enabled was not written by 3352 (its description is not 3352''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_perspective_vantage_enabled' AND enabled = FALSE;
  END IF;
END $$;

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_perspective_vantage_check;
ALTER TABLE public.posts DROP COLUMN IF EXISTS perspective_vantage;

DO $$
DECLARE present int; col int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_perspective_vantage_enabled' AND md5(coalesce(description, '')) = '417dbcc7dd94fa6a15cff3f9e965bab6';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_perspective_vantage_enabled (the row 3352 wrote) still present after rollback (% row(s))', present;
  END IF;
  SELECT count(*) INTO col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'perspective_vantage';
  IF col <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: posts.perspective_vantage still present after rollback';
  END IF;
END $$;

-- The applier wrote 3352's ledger row in 3352's own transaction; without
-- this delete it would take 3352 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3352_media_perspective_vantage.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3352_media_perspective_vantage.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3352 as applied after rollback.';
  END IF;
END $$;

COMMIT;
