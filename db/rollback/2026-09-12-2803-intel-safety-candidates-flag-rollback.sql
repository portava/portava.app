-- Rollback for 2803_intel_safety_candidates_flag.sql
--
-- Removes the `intel_safety_candidates_enabled` row. With the row absent
-- both routes read the flag fail-closed and answer feature_disabled — the
-- state before 2803, and the state the seed itself produces (FALSE).
-- Rehearsed on the local replica: apply 2803 → this file → 2803 again.
--
-- Candidates already filed (moderation_reports rows with no reporter,
-- subject_type place, category safety_concern) are NOT deleted: they are
-- questions before a reviewer, and removing a flag does not withdraw a
-- question. With the flag gone the detector simply files no more.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to
-- open the stage; deleting it silently would close a stage an operator
-- turned on. Turn it off first, then re-run.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'intel_safety_candidates_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2803 rollback: intel_safety_candidates_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'intel_safety_candidates_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'intel_safety_candidates_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2803 rollback: intel_safety_candidates_enabled survived';
  END IF;
END
$post$;
