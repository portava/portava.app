-- Rollback for 2841_experience_session_flag.sql
--
-- Removes the `experience_session_enabled` row. With the row absent the three
-- routes read the flag fail-closed and answer feature_disabled — the state
-- before 2841, and the state the seed itself produces (FALSE). There is no
-- table to drop: 2841 adds none (see its header for the §19 mapping that
-- decided that), so this file is a single DELETE and nothing else. Rehearsed on
-- the local replica: 2841 applied → this file → 2841 again.
--
-- ⚠ REFUSES IF THE FLAG READS TRUE. A TRUE row is an owner's decision to open a
-- surface that WRITES canonical events for a person; deleting it silently would
-- close a surface an operator turned on. Turn it off first, then re-run.
--
-- NOTE ON ROWS ALREADY WRITTEN. If the flag was ever TRUE, sessions may exist
-- as canonical_events rows. This file does NOT delete them, and must not: they
-- are that person's own interaction events on the canonical spine, covered by
-- the account-deletion path that already owns that table. Removing the flag
-- stops new ones; it does not rewrite history.
--
-- Idempotent: re-running after the row is gone is a no-op.

DO $pre$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'experience_session_enabled' AND enabled IS TRUE;
  IF FOUND THEN
    RAISE EXCEPTION '2841 rollback: experience_session_enabled reads TRUE — an owner enabled it. Disable it first, then re-run.';
  END IF;
END
$pre$;

DELETE FROM public.feature_flags WHERE flag = 'experience_session_enabled' AND enabled IS FALSE;

DO $post$
BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag = 'experience_session_enabled';
  IF FOUND THEN
    RAISE EXCEPTION '2841 rollback: experience_session_enabled survived';
  END IF;
END
$post$;
