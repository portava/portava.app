-- Rollback for 3808_media_asset_renditions.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3808 DID: created public.media_asset_renditions (RLS on, no policy,
-- service role SELECT, INSERT and DELETE only) and its partial index
-- media_asset_renditions_original_path_idx. It seeded no flag and wrote no row.
--
-- WHAT THIS ROLLBACK DOES: drops the table (its index goes with it) and 3808's
-- ledger row. Run again after a rollback, it is a no-op.
--
-- IT REFUSES WHILE THE TABLE NAMES AN OBJECT THE MEMORY SERVICE WROTE, unless told
-- otherwise. services/memory/memoryMediaRenditions.ts writes `<stem>.tiny.jpg`
-- (and `<stem>.viewer.jpg` / `<stem>.card.jpg` when the upload left no feed or
-- thumbnail variant) into storage, and THIS TABLE IS THE ONLY RECORD OF THEM:
-- account deletion collects them from here (collect_media_rendition_paths). Drop
-- the table and those objects can no longer be found by any deletion path. So
-- either purge them first (the §21 purge in memoryMediaRenditions.ts, or a
-- storage remove of the listed paths), or state in the session that orphaning
-- them is accepted:
--     PGOPTIONS='-c portava.rollback_3808_orphan_objects=accept' psql -f <this file>
-- Rows that only name the upload's own objects (the original, `.feed.jpg`,
-- `.thumb.jpg`) do not block: those objects are found by the asset's own
-- collectors (collect_media_asset_paths) and their lifecycle is the asset's.

BEGIN;

-- The table check and the row check are separate statements: PL/pgSQL plans a
-- statement when it first runs it, so the row check is never planned on a
-- database without the table.
DO $$
DECLARE
  v_owned bigint;
BEGIN
  IF to_regclass('public.media_asset_renditions') IS NOT NULL THEN
    SELECT count(*) INTO v_owned FROM public.media_asset_renditions
     WHERE storage_path ~ '\.(tiny|viewer|card)\.jpg$';
    IF v_owned > 0 AND coalesce(current_setting('portava.rollback_3808_orphan_objects', true), '') <> 'accept' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3808): public.media_asset_renditions is the only record of % stored object(s) the Memory service wrote (.tiny/.viewer/.card.jpg); dropping it orphans them from every deletion path. Purge them first, or set portava.rollback_3808_orphan_objects = ''accept'' in this session.', v_owned;
    END IF;
    RAISE NOTICE '3808 rollback: dropping media_asset_renditions (% service-written object path(s) recorded)', v_owned;
  END IF;
END $$;

DROP TABLE IF EXISTS public.media_asset_renditions;
DELETE FROM public.schema_migration_ledger WHERE filename = '3808_media_asset_renditions.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.media_asset_renditions') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808 rollback): public.media_asset_renditions still exists';
  END IF;
  IF to_regclass('public.media_asset_renditions_original_path_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808 rollback): media_asset_renditions_original_path_idx still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3808_media_asset_renditions.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3808 rollback): the ledger still records 3808 as applied';
  END IF;
END $post$;
