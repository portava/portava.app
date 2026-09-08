-- Rollback for 2411_layover_recommendation_rec_key_backfill.sql
--
-- NOT APPLIED ANYWHERE (2411 itself is unapplied as of 2026-09-08).
--
-- 2411 only ever writes rec_key onto rows that had rec_key NULL, and writes
-- nothing else. Undoing it means putting those rows back to NULL.
--
-- SAFETY: this is only safe while `layover_stable_recommendation_ids_enabled`
-- is FALSE. Past the cutover, keyed rows are the live rows and nulling their
-- key would make the very next regeneration sweep them and lose their ids and
-- their moderation state — the opposite of what 2411 exists to protect. The
-- guard below refuses in that case.
--
-- It also refuses to touch a row that was keyed by the SERVICE rather than by
-- 2411: `created_at` is not a reliable discriminator, so the scope is narrowed
-- to rows that carry no plan-stop reference and whose session has no keyed row
-- written after the backfill. If you need a narrower revert than that, do it by
-- explicit id list rather than widening this.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'layover_stable_recommendation_ids_enabled' AND enabled = TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: layover_stable_recommendation_ids_enabled is TRUE. Nulling rec_key now '
      'would make the next regeneration sweep live rows. Flip the flag OFF first.';
  END IF;
END $$;

UPDATE public.layover_recommendations r
   SET rec_key = NULL
 WHERE r.rec_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.layover_plan_stops s WHERE s.recommendation_id = r.id
   );

DO $$
DECLARE remaining INTEGER;
BEGIN
  SELECT count(*) INTO remaining FROM public.layover_recommendations WHERE rec_key IS NOT NULL;
  RAISE NOTICE 'ROLLBACK: % row(s) still carry a rec_key (referenced by a plan stop).', remaining;
END $$;

COMMIT;
