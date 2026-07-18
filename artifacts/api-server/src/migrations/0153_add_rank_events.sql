-- Migration 0153: rank_events impression log table (spec §7)
--
-- Records every ranked impression served by Pulse, Discovery, and Events so
-- that the impression → tap → save/join/rsvp → attended outcome funnel can be
-- reconstructed and used to fit v2 Portava weights.
--
-- item_id is TEXT (not uuid) because Discovery candidates carry OSM IDs like
-- "node/12345678" and "db/<uuid>" in addition to plain UUIDs from posts/events/
-- plans/buddies.  Using text keeps the column consistent across all surfaces.
--
-- Privacy rule (spec §8): precise GPS coordinates are never stored.  Only the
-- computed scalar features from ScoredCandidate.features are logged.

CREATE TABLE IF NOT EXISTS rank_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id     text        NOT NULL,
  item_kind   text        NOT NULL CHECK (item_kind IN ('post','event','plan','buddy','place','gem')),
  position    smallint    NOT NULL,          -- 0-indexed position in the served list
  features    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  outcome     text        NOT NULL DEFAULT 'impression'
                CHECK (outcome IN ('impression','tap','save','join','rsvp','attended')),
  served_at   timestamptz NOT NULL DEFAULT now(),
  outcome_at  timestamptz,
  surface     text        NOT NULL CHECK (surface IN ('pulse','discovery','events')),
  session_id  uuid
);

-- GIN index for feature-vector analytics queries
CREATE INDEX IF NOT EXISTS rank_events_features_gin
  ON rank_events USING GIN (features);

-- Btree index for per-user chronological queries
CREATE INDEX IF NOT EXISTS rank_events_user_served_at
  ON rank_events (user_id, served_at DESC);

-- Index for outcome upsert lookups (most recent impression for user+item)
CREATE INDEX IF NOT EXISTS rank_events_user_item
  ON rank_events (user_id, item_id, served_at DESC);

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE rank_events ENABLE ROW LEVEL SECURITY;

-- Service role: full write access (impression insert + outcome update)
CREATE POLICY "service_role_write_rank_events"
  ON rank_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users: read their own rows only
CREATE POLICY "users_read_own_rank_events"
  ON rank_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
