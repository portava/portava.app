-- Migration: 0041_trip_crew_location.sql
-- Trip crew location preferences, live-share sessions, and audit events.

CREATE TABLE IF NOT EXISTS trip_crew_location_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id         uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ghost_mode      boolean NOT NULL DEFAULT false,
  visibility      text NOT NULL DEFAULT 'circle_only',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_location_prefs_unique UNIQUE (user_id, trip_id)
);

ALTER TABLE trip_crew_location_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_crew_prefs" ON trip_crew_location_preferences
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS trip_crew_location_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id             uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  allowed_member_ids  uuid[],
  expires_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trip_crew_location_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_session_owner_select" ON trip_crew_location_sessions
  FOR SELECT USING (
    auth.uid() = user_id
    OR auth.uid() = ANY(allowed_member_ids)
  );

CREATE POLICY "crew_session_owner_insert" ON trip_crew_location_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "crew_session_owner_update" ON trip_crew_location_sessions
  FOR UPDATE USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS trip_crew_location_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trip_crew_location_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_events_trip_members" ON trip_crew_location_events
  FOR SELECT USING (auth.uid() IS NOT NULL);


-- Feature flag seeds
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('trip_crew_map_enabled',         false, 'Trip crew map feature'),
  ('trip_crew_live_share_enabled',  false, 'Trip crew live location sharing'),
  ('trip_crew_ghost_mode_enabled',  false, 'Trip crew ghost mode')
ON CONFLICT (flag) DO NOTHING;
