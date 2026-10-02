-- Rollback for 3340_media_tab_world_default_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3340 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('MEDIA_TAB_WORLD_DEFAULT_ENABLED', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. An absent row and a FALSE
-- row read the same to every reader (fail-closed), so deleting a FALSE row
-- changes nothing a user sees. If it reads TRUE, the owner has made the World shell the Media tab's default (F1); deleting the row would silently put Watch back as the opening mode, which is a product
-- change made by a script. It raises instead and the operator decides.
-- The flag's readers stay in the code; with the row gone they read false, which
-- is the behaviour before 3340 (census-media §34).

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: MEDIA_TAB_WORLD_DEFAULT_ENABLED is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3340 wrote (W10-F, census-discovery §87). 3340 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3340's seed text byte for
-- byte (the md5 below) was not written by 3340, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED' AND md5(coalesce(description, '')) <> 'e1998e24625ce132f74498218464f188') THEN
    RAISE NOTICE '3340 rollback: MEDIA_TAB_WORLD_DEFAULT_ENABLED was not written by 3340 (its description is not 3340''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED' AND md5(coalesce(description, '')) = 'e1998e24625ce132f74498218464f188';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_TAB_WORLD_DEFAULT_ENABLED (the row 3340 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3340's ledger row in 3340's own transaction; without
-- this delete it would take 3340 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3340_media_tab_world_default_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3340_media_tab_world_default_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3340 as applied after rollback.';
  END IF;
END $$;

COMMIT;
