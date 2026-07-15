-- ============================================================
-- Migration 0074: Create saved_places table and protect it from TRUNCATE
-- ============================================================
-- `saved_places` is the user wishlist table — rows record that a user
-- has saved a discovery place for later. A bulk TRUNCATE from the
-- Supabase dashboard or psql would silently wipe every user's
-- wishlist in one statement, bypassing RLS entirely.
--
-- This migration:
--   1. Creates the `saved_places` table (IF NOT EXISTS) so the trigger
--      can be attached whether or not the table already exists.
--   2. Adds a STATEMENT-level BEFORE TRUNCATE trigger that unconditionally
--      raises an integrity constraint violation (SQLSTATE 23000).
--
-- Row-level BEFORE DELETE triggers are never invoked by TRUNCATE in
-- PostgreSQL, so a statement-level trigger is the only mechanism that
-- intercepts it. Legitimate bulk-deletes must use DELETE with a WHERE
-- clause, which is auditable and row-level triggers can inspect.
-- ============================================================

CREATE TABLE IF NOT EXISTS saved_places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  place_id   uuid NOT NULL REFERENCES discovery_places(id) ON DELETE CASCADE,
  saved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, place_id)
);

ALTER TABLE saved_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own saved places" ON saved_places;
CREATE POLICY "Users can manage their own saved places"
  ON saved_places
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS saved_places_user_id_idx ON saved_places (user_id, saved_at DESC);

-- ── TRUNCATE guard ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_saved_places_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'TRUNCATE on saved_places is not allowed. '
    'It would silently wipe every user''s wishlist. '
    'Use DELETE with a WHERE clause instead.'
    USING ERRCODE = '23000'; -- integrity_constraint_violation
END;
$$;

DROP TRIGGER IF EXISTS block_saved_places_truncate ON saved_places;

CREATE TRIGGER block_saved_places_truncate
  BEFORE TRUNCATE ON saved_places
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_saved_places_truncate();
