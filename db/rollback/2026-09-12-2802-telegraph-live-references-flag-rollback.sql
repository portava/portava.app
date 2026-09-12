-- Rollback for 2802_telegraph_live_references_flag.sql
--
-- Removes the `telegraph_live_references_enabled` row. With the row absent
-- both routes read the flag fail-closed and answer feature_disabled — the
-- state before 2802, and the state the seed itself produces (FALSE). Rehearsed
-- on the local replica: apply 2802 → this file → 2802 again.
--
-- Live-reference cards already written (messages rows of subtype
-- live_reference) are NOT deleted: they are members' messages, and removing a
-- flag does not unsend a conversation. With the flag gone they simply stop
-- resolving (GET answers feature_disabled) until it is seeded again.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to open
-- the surface; deleting it silently would close a surface an operator turned
-- on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'telegraph_live_references_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2802 rollback: telegraph_live_references_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'telegraph_live_references_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'telegraph_live_references_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2802 rollback: telegraph_live_references_enabled survived';
  END IF;
END
$post$;
