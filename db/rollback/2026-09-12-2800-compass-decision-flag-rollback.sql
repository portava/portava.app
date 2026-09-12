-- Rollback for 2800_compass_decision_flag.sql
--
-- Removes the `compass_decision_enabled` row. With the row absent the route
-- reads the flag fail-closed and answers feature_disabled — the state before
-- 2800, and the state the seed itself produces (FALSE). Rehearsed on the local
-- replica: apply 2800 → this file → 2800 again.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to open
-- the surface; deleting it silently would close a surface an operator turned
-- on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'compass_decision_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2800 rollback: compass_decision_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'compass_decision_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'compass_decision_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2800 rollback: compass_decision_enabled survived';
  END IF;
END
$post$;
