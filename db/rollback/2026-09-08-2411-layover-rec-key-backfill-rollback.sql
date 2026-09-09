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
-- SCOPE, STATED AS WHAT THE SQL ACTUALLY DOES.
--
-- This header used to claim the revert "refuses to touch a row that was keyed by
-- the SERVICE rather than by 2411", narrowed to rows "whose session has no keyed
-- row written after the backfill". THAT SECOND TERM IS NOT IMPLEMENTED AND
-- CANNOT BE: the UPDATE below carries only `rec_key IS NOT NULL` and a
-- `layover_plan_stops NOT EXISTS`, and 2411 writes no provenance — no marker, no
-- timestamp of its own — so no predicate can tell a key it wrote from a key the
-- service wrote. `created_at` is the row's, not the key's.
--
-- A false scope claim is worse than a declared loss, so here is the loss:
--
--   THIS REVERT NULLS rec_key ON EVERY UNREFERENCED KEYED ROW, whoever keyed it.
--   A row keyed by LayoverRecommendationService and not yet attached to a plan
--   stop is indistinguishable from a row keyed by 2411 and will be nulled too.
--
-- What bounds the damage is the flag guard above, not this scope: while
-- `layover_stable_recommendation_ids_enabled` is FALSE the service does not key
-- rows at all, so the two populations cannot overlap and the loss is empty. That
-- is an accident of flag state, and it is the ONLY thing making this revert safe
-- — which is exactly why the guard refuses once the flag is TRUE.
--
-- If you need a narrower revert, do it by explicit id list. Do not widen this.

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
