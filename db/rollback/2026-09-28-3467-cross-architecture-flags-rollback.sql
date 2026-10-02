-- Rollback for 3467_cross_architecture_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3467 DID: inserted discovery_trip_viewer_projections_enabled and
-- telegraph_discovery_actions_enabled (FALSE), and rewrote the DESCRIPTION of
-- media_pending_upload_sweep_enabled from the one-hour rule to D-W10S2-6's.
-- WHAT THIS ROLLBACK DOES: refuses while either new flag is TRUE; deletes the
-- two rows; restores 3400's description text verbatim (its `enabled` is never
-- touched); deletes 3467's ledger row.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_trip_viewer_projections_enabled', 'telegraph_discovery_actions_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3467): a flag seeded by 3467 is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('discovery_trip_viewer_projections_enabled', 'telegraph_discovery_actions_enabled') AND enabled = FALSE;

UPDATE public.feature_flags
   SET description = 'Abandoned-upload sweep (census-discovery DV-77, §56): Phase 0.4, no unstripped original persists because a completion handler never ran. ON: hourly, every post_media row still pending an hour after its slot was reserved has its original, feed variant, resumable parts and poster removed from post-media, then the row deleted (oldest first, 200 a pass; a failed removal keeps the row). OFF / absent (the seed): nothing runs. Unreadable: nothing runs and the pass records a failure. Turning it ON deletes never-completed uploads, including a resumable upload still in progress after an hour; that is an owner decision.'
 WHERE flag = 'media_pending_upload_sweep_enabled'
   AND description LIKE '%§81 D-W10S2-6%';

DELETE FROM public.schema_migration_ledger WHERE filename = '3467_cross_architecture_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_trip_viewer_projections_enabled', 'telegraph_discovery_actions_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3467 rollback): a flag is still present.';
  END IF;
END $post$;
