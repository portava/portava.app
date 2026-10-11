-- Rollback for 3748_telegraph_ride_proposal_identity_unique.sql (census-telegraph T107, §80).
-- NOT applied to any database at the time of writing.
--
-- WHAT 3748 DID
-- =============
--   * Asserted 2810's column messages.idempotency_key and its partial unique
--     index messages_idempotency_uniq, refusing on any duplicate request identity.
--   * CREATE UNIQUE INDEX IF NOT EXISTS with 2810's exact definition — a no-op
--     wherever 2810 applied.
--   * Set a COMMENT on that index naming the shared-ride writer.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Clears the comment (2810 set none). It does NOT drop the index: the index is
-- 2810's, and §17.2's idempotent send (3654) stands on it as well. Rows written
-- with an idempotency_key keep it.
--
-- WHAT IT DOES NOT UNDO, stated: with the index in place the ride route keeps
-- writing one row per request identity. Rolling the route back is an
-- application revert, not a schema one.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.messages_idempotency_uniq') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK PRECONDITION FAILED (3748): messages_idempotency_uniq does not exist; nothing of 3748 to roll back.';
  END IF;
END $pre$;

COMMENT ON INDEX public.messages_idempotency_uniq IS NULL;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.messages_idempotency_uniq') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3748): the rollback removed 2810''s index.';
  END IF;
  IF obj_description(to_regclass('public.messages_idempotency_uniq'), 'pg_class') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3748): the index comment survived.';
  END IF;
END $post$;
