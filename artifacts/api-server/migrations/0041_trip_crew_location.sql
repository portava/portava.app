-- Migration 0041: Trip Crew Location Coordination
-- Three tables for privacy-safe location sharing within trip crews.
-- Exact coordinates are NEVER stored in these tables — all location data
-- comes from user_location_state (read at query time) and is blurred before
-- it leaves the API.

-- ── trip_crew_location_preferences ───────────────────────────────────────────
-- Per-user per-trip sharing preferences; ghost mode toggle lives here.

CREATE TABLE IF NOT EXISTS trip_crew_location_preferences (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  default_visibility text NOT NULL DEFAULT 'city_only'
    CHECK (default_visibility IN ('hidden','city_only','neighborhood','nearby','arrived_only')),
  ghost_mode_enabled      boolean NOT NULL DEFAULT false,
  share_arrival_status    boolean NOT NULL DEFAULT true,
  share_safe_return_status boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id)
);

-- RLS: users manage their own row; accepted trip members can read all prefs for their trip
ALTER TABLE trip_crew_location_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_prefs_self_write" ON trip_crew_location_preferences
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "crew_prefs_members_read" ON trip_crew_location_preferences
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trips WHERE trips.id = trip_id AND trips.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_members.trip_id = trip_crew_location_preferences.trip_id
        AND trip_members.user_id = auth.uid()
        AND trip_members.role IN ('owner', 'member')
    )
  );

-- ── trip_crew_location_sessions ───────────────────────────────────────────────
-- Timed live-share grants. expires_at drives server-side expiry sweep.
-- No lat/lng columns — locations come from user_location_state at query time.

CREATE TABLE IF NOT EXISTS trip_crew_location_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  visibility_level text   NOT NULL DEFAULT 'neighborhood'
    CHECK (visibility_level IN ('city_only','neighborhood','nearby')),
  status      text        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','stopped')),
  allowed_member_ids text[] NOT NULL DEFAULT '{}',
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  stopped_at  timestamptz,
  last_location_snapshot_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_crew_location_sessions_active_idx
  ON trip_crew_location_sessions (trip_id, status, expires_at)
  WHERE status = 'active';

-- RLS: users manage their own sessions; allowed recipients can read active sessions
ALTER TABLE trip_crew_location_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_sessions_self" ON trip_crew_location_sessions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "crew_sessions_recipients_read" ON trip_crew_location_sessions
  FOR SELECT USING (
    status = 'active'
    AND expires_at > now()
    AND auth.uid()::text = ANY(allowed_member_ids)
  );

-- ── trip_crew_location_events ─────────────────────────────────────────────────
-- Audit log for all crew location actions.

CREATE TABLE IF NOT EXISTS trip_crew_location_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type  text        NOT NULL CHECK (event_type IN (
    'ghost_mode_on','ghost_mode_off',
    'live_share_started','live_share_stopped','live_share_expired',
    'preferences_updated','access_revoked'
  )),
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_crew_location_events_trip_idx
  ON trip_crew_location_events (trip_id, created_at DESC);

-- RLS: accepted trip members read events for their trip; service role writes
ALTER TABLE trip_crew_location_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_events_members_read" ON trip_crew_location_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trips WHERE trips.id = trip_id AND trips.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM trip_members
      WHERE trip_members.trip_id = trip_crew_location_events.trip_id
        AND trip_members.user_id = auth.uid()
        AND trip_members.role IN ('owner', 'member')
    )
  );

-- ── Feature flags ─────────────────────────────────────────────────────────────

INSERT INTO feature_flags (key, enabled, description, updated_at)
VALUES
  ('trip_crew_map_enabled',        true, 'Enable the Trip Crew location map feature', now()),
  ('trip_crew_live_share_enabled', true, 'Enable temporary live location sharing within trip crew', now()),
  ('trip_crew_ghost_mode_enabled', true, 'Enable ghost mode for trip crew location hiding', now())
ON CONFLICT (key) DO NOTHING;
