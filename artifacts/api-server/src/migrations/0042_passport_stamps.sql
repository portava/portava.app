-- Migration: 0042_passport_stamps.sql
-- Creates passport_stamps, passport_memories, passport_contribution_events,
-- and passport_visibility_preferences tables.

CREATE TABLE IF NOT EXISTS passport_stamps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stamp_type   text NOT NULL,
  country      text,
  city         text,
  earned_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passport_stamps_dedup UNIQUE (user_id, stamp_type, country, city)
);

ALTER TABLE passport_stamps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_own_stamps"   ON passport_stamps FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_insert_own_stamp"  ON passport_stamps FOR INSERT WITH CHECK (auth.uid() = user_id);


-- Passport memories: suggested → active → dismissed lifecycle
CREATE TABLE IF NOT EXISTS passport_memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  trip_id      uuid REFERENCES trips(id) ON DELETE SET NULL,
  title        text,
  body         text,
  status       text NOT NULL DEFAULT 'suggested',
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_memories" ON passport_memories
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- Contribution events (append-only, no Trust Score modification)
CREATE TABLE IF NOT EXISTS passport_contribution_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_contribution_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_own_contributions" ON passport_contribution_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "users_insert_contribution" ON passport_contribution_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);


-- Visibility preferences for passport sections
CREATE TABLE IF NOT EXISTS passport_visibility_preferences (
  user_id            uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  stamps_visibility  text NOT NULL DEFAULT 'public',
  map_visibility     text NOT NULL DEFAULT 'circle_only',
  memories_visible   boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE passport_visibility_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_passport_prefs" ON passport_visibility_preferences
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- Feature flag seeds
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('passport_stamps_enabled',       false, 'Passport stamps feature'),
  ('passport_memories_enabled',     false, 'Passport memories feature'),
  ('passport_map_enabled',          false, 'Passport map feature'),
  ('passport_contribution_enabled', false, 'Passport contribution events')
ON CONFLICT (flag) DO NOTHING;
