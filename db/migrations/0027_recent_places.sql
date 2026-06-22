-- Migration 0027: user_recent_places
-- Stores each user's recently selected Place objects (JSONB snapshot)
-- so the app can surface them in GlobalPlacePicker without a search.

CREATE TABLE IF NOT EXISTS user_recent_places (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  place_snapshot jsonb   NOT NULL,
  used_for   text,                      -- e.g. 'trip_destination', 'highlight_location'
  used_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_recent_places_place_id_unique UNIQUE NULLS NOT DISTINCT (user_id, (place_snapshot->>'id'))
);

CREATE INDEX IF NOT EXISTS user_recent_places_user_used_at_idx
  ON user_recent_places(user_id, used_at DESC);

-- RLS
ALTER TABLE user_recent_places ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own recent places"
  ON user_recent_places FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own recent places"
  ON user_recent_places FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users delete own recent places"
  ON user_recent_places FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypasses RLS for cleanup / batch writes
