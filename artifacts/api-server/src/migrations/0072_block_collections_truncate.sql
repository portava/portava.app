-- ============================================================
-- Migration 0072: Block TRUNCATE on collections
-- ============================================================
-- PostgreSQL BEFORE DELETE row-level triggers (added in 0071)
-- do NOT fire for TRUNCATE TABLE. An admin running:
--
--   TRUNCATE TABLE collections;
--
-- from the Supabase SQL editor or psql would bypass the
-- prevent_default_collection_delete() trigger entirely and,
-- because collection_items has ON DELETE CASCADE, instantly
-- wipe every saved item for every user.
--
-- This migration adds a STATEMENT-level BEFORE TRUNCATE trigger
-- on `collections`. Statement-level triggers are the only way
-- to intercept TRUNCATE in PostgreSQL — row-level triggers are
-- never invoked by TRUNCATE, regardless of timing (BEFORE/AFTER).
--
-- The trigger unconditionally raises an error (SQLSTATE 23000).
-- If a legitimate bulk-delete is ever needed, the correct
-- approach is:
--
--   DELETE FROM collections WHERE <condition>;
--
-- which fires the per-row trigger and is blocked only for
-- rows where is_default = TRUE, allowing non-default collection
-- cleanup to proceed safely.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_collections_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'TRUNCATE on collections is not allowed. '
    'It would bypass the is_default guard and cascade-delete every '
    'user''s saved items via collection_items ON DELETE CASCADE. '
    'Use DELETE with a WHERE clause instead.'
    USING ERRCODE = '23000'; -- integrity_constraint_violation
END;
$$;

DROP TRIGGER IF EXISTS block_collections_truncate ON collections;

CREATE TRIGGER block_collections_truncate
  BEFORE TRUNCATE ON collections
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_collections_truncate();
