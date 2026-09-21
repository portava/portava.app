-- Rollback for 2851_layover_live_intersection_flag.sql
--
-- Removes the `layover_live_intersection_enabled` row. With the row absent
-- services/airport/LayoverRecommendationService reads the flag fail-closed, the
-- live pass does not run, no claim is read, and every card is generated with
-- the activity time it already had — the state before 2851, and the state the
-- seed itself produces (FALSE).
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to let a
-- live reading REMOVE a card and change a safety rating; deleting it silently
-- would close a surface an operator turned on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_live_intersection_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2851 rollback: layover_live_intersection_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_live_intersection_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_live_intersection_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2851 rollback: layover_live_intersection_enabled survived';
  END IF;
END
$post$;
