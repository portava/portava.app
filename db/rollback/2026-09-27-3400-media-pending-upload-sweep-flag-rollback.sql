-- Rollback for 3400_media_pending_upload_sweep_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3400 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_pending_upload_sweep_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function, no
--     storage policy.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the abandoned-upload sweep on since 3400 was applied;
-- deleting the row would silently turn it off again (an absent row reads as
-- absent, and the scheduler does nothing) and unstripped originals of
-- never-completed uploads would start accumulating in post-media again with
-- nothing on any screen saying so. It raises instead and the operator decides.
--
-- It then deletes 3400's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3400. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_pending_upload_sweep_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3400): media_pending_upload_sweep_enabled is TRUE. The owner has turned the abandoned-upload sweep on since 3400 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3400 wrote (W10-F, census-discovery §87). 3400 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3400's seed text byte for
-- byte (the md5 below) was not written by 3400, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_pending_upload_sweep_enabled' AND md5(coalesce(description, '')) <> '9b571bb51b3141bf31219c8cd4e7d39e') THEN
    RAISE NOTICE '3400 rollback: media_pending_upload_sweep_enabled was not written by 3400 (its description is not 3400''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_pending_upload_sweep_enabled' AND enabled = FALSE;
  END IF;
END $$;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3400_media_pending_upload_sweep_flag.sql';

COMMIT;

-- ── Postconditions: the row is gone, and so is the ledger row ───────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_pending_upload_sweep_enabled'
                AND md5(coalesce(description, '')) = '9b571bb51b3141bf31219c8cd4e7d39e') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3400 rollback): media_pending_upload_sweep_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3400_media_pending_upload_sweep_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3400 rollback): the ledger still records 3400 as applied.';
  END IF;
END $post$;
