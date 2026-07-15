-- ============================================================
-- Migration 0073: Block TRUNCATE on collection_items
-- ============================================================
-- Migrations 0071 and 0072 protect the `collections` table:
--   0071 - BEFORE DELETE row-level trigger (blocks is_default deletion)
--   0072 - BEFORE TRUNCATE statement-level trigger (blocks TRUNCATE collections)
--
-- However, `collection_items` has no equivalent TRUNCATE guard.
-- An admin running:
--
--   TRUNCATE TABLE collection_items;
--   TRUNCATE TABLE collection_items CASCADE;
--
-- from the Supabase SQL editor or psql bypasses both 0071 and 0072
-- entirely (those triggers are on `collections`, not `collection_items`)
-- and silently wipes every saved item for every user without touching
-- the `collections` rows themselves.
--
-- This migration adds a STATEMENT-level BEFORE TRUNCATE trigger on
-- `collection_items`. Statement-level triggers are the only PostgreSQL
-- mechanism that intercepts TRUNCATE — row-level triggers are never
-- invoked by TRUNCATE, regardless of timing (BEFORE/AFTER).
--
-- The trigger unconditionally raises an error (SQLSTATE 23000).
-- If a legitimate bulk-delete of items is ever needed, the correct
-- approach is:
--
--   DELETE FROM collection_items WHERE <condition>;
--
-- which fires any per-row triggers and is auditable.
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_collection_items_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'TRUNCATE on collection_items is not allowed. '
    'It would silently wipe every saved item for every user. '
    'Use DELETE with a WHERE clause instead.'
    USING ERRCODE = '23000'; -- integrity_constraint_violation
END;
$$;

DROP TRIGGER IF EXISTS block_collection_items_truncate ON collection_items;

CREATE TRIGGER block_collection_items_truncate
  BEFORE TRUNCATE ON collection_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_collection_items_truncate();
