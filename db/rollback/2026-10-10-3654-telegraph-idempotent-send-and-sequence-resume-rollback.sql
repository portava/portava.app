-- Rollback for 3654_telegraph_idempotent_send_and_sequence_resume.sql
-- NOT applied to any database at the time of writing.
--
-- WHAT 3654 DID
-- =============
--   * Seeded two CAPABILITY flags FALSE: telegraph_idempotent_send_enabled and
--     telegraph_sequence_resume_enabled. Nothing else — no table, column,
--     index, function, policy or grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes the two flag rows. The application reads both with isFlagEnabled
-- (false when the row is absent), so the send and read routes return to their
-- pre-3654 behaviour immediately. Rows already written with an idempotency_key
-- keep it; that column and its index belong to 2810 and are left alone.

BEGIN;

DELETE FROM public.feature_flags
 WHERE flag IN ('telegraph_idempotent_send_enabled', 'telegraph_sequence_resume_enabled');

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('telegraph_idempotent_send_enabled', 'telegraph_sequence_resume_enabled')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3654): a 3654 flag row survived.';
  END IF;
END $post$;

COMMIT;
