-- Rollback for 2801_wall_moments_flag.sql
--
-- Removes the `wall_moments_enabled` row. With the row absent the route
-- reads the flag fail-closed and answers feature_disabled — the state before
-- 2801, and the state the seed itself produces (FALSE). Rehearsed on the
-- local replica: apply 2801 → this file → 2801 again.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to open
-- the surface; deleting it silently would close a surface an operator turned
-- on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'wall_moments_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2801 rollback: wall_moments_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'wall_moments_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'wall_moments_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2801 rollback: wall_moments_enabled survived';
  END IF;
END
$post$;
