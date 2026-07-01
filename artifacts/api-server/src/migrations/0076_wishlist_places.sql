-- Migration 0076: wishlist_places
--
-- Stores full place data as JSONB so any bookmarked place (DB-sourced or
-- OSM-sourced) can be persisted under the user's account.  Separate from
-- saved_places (0074) which carries a FK to discovery_places and is reserved
-- for DB-only place saves.
--
-- API server writes via service role key (bypasses RLS) because the Supabase
-- PostgREST layer does not fully support ECC P-256 JWTs yet.  The policy below
-- is a belt-and-suspenders guard for direct DB access.

CREATE TABLE IF NOT EXISTS wishlist_places (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  place_id   text        NOT NULL,
  place_data jsonb       NOT NULL,
  list_id    text        NOT NULL DEFAULT 'global',
  saved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, place_id, list_id)
);

ALTER TABLE wishlist_places ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own wishlist places" ON wishlist_places;
CREATE POLICY "Users manage own wishlist places" ON wishlist_places
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS wishlist_places_user_list_idx
  ON wishlist_places(user_id, list_id, saved_at DESC);

-- TRUNCATE guard — a plain TRUNCATE would bypass the per-row RLS and silently
-- wipe every user's wishlist.  The trigger raises SQLSTATE 23000 so any
-- accidental TRUNCATE from the dashboard or psql is rejected.
CREATE OR REPLACE FUNCTION prevent_wishlist_places_truncate()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23000',
    MESSAGE = 'TRUNCATE wishlist_places is not allowed; use DELETE … WHERE instead';
END;
$$;

DROP TRIGGER IF EXISTS block_wishlist_places_truncate ON wishlist_places;
CREATE TRIGGER block_wishlist_places_truncate
  BEFORE TRUNCATE ON wishlist_places
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_wishlist_places_truncate();
