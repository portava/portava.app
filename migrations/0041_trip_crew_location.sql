-- Migration 0041: trip_crew_location
-- Per-trip ghost mode + visibility prefs, timed live-share sessions, and audit events.
-- Feature flag seeds for trip_crew_map, live_share, and ghost_mode.

-- ── trip_crew_location_preferences ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_crew_location_preferences (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id            uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ghost_mode_enabled boolean     NOT NULL DEFAULT false,
  visibility_default text        NOT NULL DEFAULT 'crew',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, trip_id)
);

ALTER TABLE trip_crew_location_preferences ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS crew_loc_prefs_trip_idx ON trip_crew_location_preferences(trip_id);

CREATE POLICY "crew_loc_prefs_own" ON trip_crew_location_preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "crew_loc_prefs_service" ON trip_crew_location_preferences
  FOR ALL TO service_role USING (true);

-- ── trip_crew_location_sessions: timed live-share sessions ───────────────────
CREATE TABLE IF NOT EXISTS trip_crew_location_sessions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id            uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  allowed_member_ids uuid[],
  expires_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trip_crew_location_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS crew_loc_sessions_trip_idx ON trip_crew_location_sessions(trip_id);
CREATE INDEX IF NOT EXISTS crew_loc_sessions_user_idx ON trip_crew_location_sessions(user_id);

CREATE POLICY "crew_loc_sessions_own" ON trip_crew_location_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "crew_loc_sessions_trip_member_read" ON trip_crew_location_sessions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_id = trip_crew_location_sessions.trip_id AND user_id = auth.uid()
    )
  );

CREATE POLICY "crew_loc_sessions_service" ON trip_crew_location_sessions
  FOR ALL TO service_role USING (true);

-- ── trip_crew_location_events: audit log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_crew_location_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id    uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  event_type text        NOT NULL
             CHECK (event_type IN ('ghost_on', 'ghost_off', 'live_share_start', 'live_share_end')),
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trip_crew_location_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS crew_loc_events_trip_idx ON trip_crew_location_events(trip_id);
CREATE INDEX IF NOT EXISTS crew_loc_events_user_idx ON trip_crew_location_events(user_id);

CREATE POLICY "crew_loc_events_own_read" ON trip_crew_location_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "crew_loc_events_service" ON trip_crew_location_events
  FOR ALL TO service_role USING (true);

-- ── Feature flag seeds ────────────────────────────────────────────────────────
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('trip_crew_map_enabled',        false, 'Show crew location map in trip view'),
  ('trip_crew_live_share_enabled', false, 'Enable real-time location sharing with trip crew'),
  ('trip_crew_ghost_mode_enabled', false, 'Enable ghost mode for trip crew location')
ON CONFLICT (flag) DO NOTHING;
