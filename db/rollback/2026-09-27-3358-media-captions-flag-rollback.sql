-- Rollback for 3358_media_captions_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3358 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_captions_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the captions stage on since 3358 was applied; deleting the
-- row would silently turn it off (an absent row reads false). It raises instead
-- and the operator decides. Caption tracks already stored at
-- `<storage_path>.captions.vtt` are Storage objects and are not touched here.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_captions_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_captions_enabled is TRUE. The owner has turned the captions stage on since 3358 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3358 wrote (W10-F, census-discovery §87). 3358 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3358's seed text byte for
-- byte (the md5 below) was not written by 3358, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_captions_enabled' AND md5(coalesce(description, '')) <> '0b78958c0f5ed803e82d6c2632a09e53') THEN
    RAISE NOTICE '3358 rollback: media_captions_enabled was not written by 3358 (its description is not 3358''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_captions_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_captions_enabled' AND md5(coalesce(description, '')) = '0b78958c0f5ed803e82d6c2632a09e53';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_captions_enabled (the row 3358 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3358's ledger row in 3358's own transaction; without
-- this delete it would take 3358 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3358_media_captions_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3358_media_captions_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3358 as applied after rollback.';
  END IF;
END $$;

COMMIT;
