-- Rollback for 2840_opportunity_engine_flag.sql
--
-- Removes the `opportunity_engine_enabled` row. With the row absent the route
-- reads the flag fail-closed and answers feature_disabled — the state before
-- 2840, and the state the seed itself produces (FALSE). Rehearsed on the local
-- replica: 2840 applied in the chain → this file → 2840 again, FALSE both
-- times; and over a hand-set TRUE row 2840 raised its postcondition and
-- committed nothing.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to open
-- the surface; deleting it silently would close a surface an operator turned
-- on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'opportunity_engine_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2840 rollback: opportunity_engine_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'opportunity_engine_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'opportunity_engine_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2840 rollback: opportunity_engine_enabled survived';
  END IF;
END
$post$;
