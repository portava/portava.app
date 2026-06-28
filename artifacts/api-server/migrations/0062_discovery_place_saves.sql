-- 0062_discovery_place_saves
-- Tracks which users saved which community discovery places.
-- Backed by the existing `discovery_places` table (0029_discovery_places.sql).
-- The save action previously only incremented saved_count on discovery_places —
-- this adds a per-user row so GET /discovery/community/saved-ids can return
-- the user's saved set across sessions.

CREATE TABLE IF NOT EXISTS discovery_place_saves (
  user_id   UUID        NOT NULL REFERENCES profiles(id)          ON DELETE CASCADE,
  place_id  UUID        NOT NULL REFERENCES discovery_places(id)  ON DELETE CASCADE,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, place_id)
);

ALTER TABLE discovery_place_saves ENABLE ROW LEVEL SECURITY;

-- Users may record their own saves.
CREATE POLICY "Users insert own saves"
  ON discovery_place_saves FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users may read their own saves (used by GET /discovery/community/saved-ids).
CREATE POLICY "Users read own saves"
  ON discovery_place_saves FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role needs full access for the API server (bypasses RLS).
-- (service_role bypasses RLS by default; no explicit policy needed.)

-- Explicit single-column index so the WHERE user_id = $1 filter in
-- GET /saved-ids avoids a full table scan as the table grows.
CREATE INDEX IF NOT EXISTS discovery_place_saves_user_idx
  ON discovery_place_saves (user_id);
