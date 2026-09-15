-- Rollback for 2850_discovery_live_rank_flag.sql
--
-- Removes the `discovery_live_rank_enabled` row. With the row absent
-- lib/discoveryLiveRankRead reads the flag fail-closed and the serve path
-- returns the very array it was handed, reading no claim and moving no row —
-- the state before 2850, and the state the seed itself produces (FALSE).
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to let
-- live intelligence change the ORDER a real user is served; deleting it
-- silently would close a surface an operator turned on. Turn it off first,
-- then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'discovery_live_rank_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2850 rollback: discovery_live_rank_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'discovery_live_rank_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'discovery_live_rank_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2850 rollback: discovery_live_rank_enabled survived';
  END IF;
END
$post$;
